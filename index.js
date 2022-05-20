const core = require('@actions/core')
const {Octokit} = require('@octokit/rest')
const {retry} = require('@octokit/plugin-retry')
const {throttling} = require('@octokit/plugin-throttling')

const _Octokit = Octokit.plugin(retry, throttling)

async function newClient(token) {
    const config = {
        auth: token,
        throttle: {
            onRateLimit: (retryAfter, options, octokit) => {
                octokit.log.warn(
                    `Request quota exhausted for request ${options.method} ${options.url}`
                );
                if (options.request.retryCount <= 1) {
                    octokit.log.info(`Retrying after ${retryAfter} seconds!`);
                    return true;
                }
            },
            onAbuseLimit: (retryAfter, options, octokit) => {
                octokit.log.warn(`Abuse detected for request ${options.method} ${options.url}`);
                if (options.request.retryCount === 0) {
                    octokit.log.info(`Retrying after ${retryAfter} seconds!`);
                    return true;
                }
            },
        }
    }
    return new _Octokit(config)
}

const query = `query($org: String!, $page: String) {
      organization(login: $org) {
        membersWithRole(first: 100, after: $page) {
          pageInfo {
            endCursor
            hasNextPage
          }
          nodes {
            login
            organizationVerifiedDomainEmails(login: $org)
          }
        }
      }
    }`

async function getOffendingUsers(client, org) {
    let hasNextPage = true
    let page = null
    const users = []

    core.info(`Retrieving users for ${org}`)
    while (hasNextPage) {
        const response = await client.graphql(query, {
            org: org,
            page: page
        })
        users.push(...response.organization.membersWithRole.nodes)
        page = response.organization.membersWithRole.pageInfo.endCursor
        hasNextPage = response.organization.membersWithRole.pageInfo.hasNextPage
    }
    // Filter those that have verified domain emails
    core.info(`Evaluating users without verified domain emails`)
    return users.filter((user) => user.organizationVerifiedDomainEmails.length === 0).map((user) => user.login)
}

async function processUser(client, org, repo, user, message) {
    if (!user.site_admin) {
        let issues
        try {
            console.log(`Searching for existing issue for ${user}`)
            issues = await client.paginate(client.issues.listForRepo, {
                owner: org,
                repo: repo,
                assignee: user,
                labels: ['compliance-unverified-email'],
                state: 'all',
                sort: 'created',
                direction: 'desc',
                per_page: 100
            })

            if (issues.length > 0) {
                if (issues[0].labels.map(label => label.name).includes('bot-account')) {
                    core.info(`Bot account found, skipping: ${user}`)
                    return
                }
                const date = new Date()
                const created = new Date(issues[0].created_at)
                // If it's been more than 60 days evaluate the issue for an exception or closure
                if (date.getTime() - created.getTime() > 60 * 24 * 60 * 60 * 1000) {
                    console.log(`Opening issue for ${user}`)
                    await client.issues.create({
                        owner: org,
                        repo: repo,
                        title: `Compliance: Unverified Email Address -- ${user}`,
                        assignees: [user],
                        body: message,
                        labels: ['compliance-unverified-email']
                    })
                } else {
                    console.log(`Existing issue not yet stale for ${user}`)
                }
            } else {
                console.log(`Opening issue for ${user}`)
                await client.issues.create({
                    owner: org,
                    repo: repo,
                    title: `Compliance: Unverified Email Address -- ${user}`,
                    assignees: [user],
                    body: message,
                    labels: ['compliance-unverified-email']
                })
            }
        } catch (err) {
            core.error(err.message)
        }
    }
}

async function closeIssue(client, org, repo, issueNumber) {
    try {
        console.log(`Closing issue ${issueNumber}`)
        await client.issues.update({
            owner: org,
            repo: repo,
            issue_number: issueNumber,
            state: 'closed'
        })
    } catch (err) {
        core.error(err.message)
    }
}

// Remove user from organization
async function removeUser(client, org, user) {
    core.info(`Removing user ${user} from ${org}`)
    await client.orgs.removeMember({
        org: org,
        username: user
    })
}

// Comment on issue
async function comment(client, org, repo, issueNumber, user, message) {
    core.info(`Commenting on issue ${issueNumber}`)
    await client.issues.createComment({
        owner: org,
        repo: repo,
        issue_number: issueNumber,
        body: message
    })
}

// Retrieves users who have been added in the last x days to the organization
async function retrieveUsersFromAuditLog(client, org, days) {
    try {
        const date = new Date()
        date.setDate(date.getDate() - days)
        const phrase = `action:org.add_member created:>=${date.toISOString()}`

        core.info(`Retrieving audit log for ${org}`)
        const logs = await client.paginate('GET /orgs/{org}/audit-log', {
            org: org,
            phrase: phrase,
            include: 'web',
            per_page: 100
        })
        return logs.map(entry => entry.user)
    } catch (err) {
        core.setFailed(`Failed to retrieve audit log: ${err.message}`)
        process.exit(1)
    }
}

// Determines users who have not been added in the last x days to the organization and still don't have a valid email address
async function intersect(newUsers, nonCompliantUsers) {
    const violations = []
    for (const user of nonCompliantUsers) {
        if (!newUsers.includes(user) && !user.includes('-bot')) {
            violations.push(user)
        }
    }
    return violations
}

async function retrieveIssues(client, org, repo) {
    try {
        core.info(`Retrieving issues for ${org}/${repo}`)
        return await client.paginate(client.issues.listForRepo, {
            owner: org,
            repo: repo,
            per_page: 100
        })
    } catch (err) {
        core.setFailed(`Failed to retrieve issues: ${err.message}`)
        process.exit(1)
    }
}

async function validateEvent(client, org, repo, issueNumber) {
    try {
        core.info(`Retrieving events for ${org}/${repo}#${issueNumber}`)
        const events = await client.paginate(client.issues.listEvents, {
            owner: org,
            repo: repo,
            issue_number: issueNumber,
            per_page: 100
        })
        for (const event of events) {
            if (event.event === 'labeled') {
                if (event.label.name === 'request-granted' && event.user.site_admin) {
                    return true
                }
            }
        }
        return false
    } catch (err) {
        core.setFailed(`Failed to retrieve events: ${err.message}`)
    }
}

async function processIssue(client, org, repo, issue) {
    const labels = issue.labels.map(label => label.name)
    if (labels.includes('request-granted')) {
        try {
            const validated = await validateEvent(client, org, repo, issue.number)
            if (!validated) {
                for (const assignee of issue.assignees) {
                    if (!assignee.site_admin) {
                        await removeUser(client, org, assignee.login)
                        await comment(client, org, repo, issue.number, `${assignee.login} has been removed from the ${org} organization.`)
                    }
                }
            } else {
                await comment(client, org, repo, issue.number, `An exemption has been granted.`)
            }
        } catch (err) {
            core.error(`Failed to process issue ${issue.html_url}: ${err.message}`)
        }
    } else {
        for (const assignee of issue.assignees) {
            if (!assignee.site_admin) {
                await removeUser(client, org, assignee.login)
                await comment(client, org, repo, issue.number, `${assignee.login} has been removed from the ${org} organization.`)
            }
        }
    }
    await closeIssue(client, org, repo, issue.number)
}


(async function main() {
    const action = core.getInput('action', {required: true, trimWhitespace: true})
    const days = parseInt(core.getInput('days', {required: true, trimWhitespace: true}))
    const message = core.getInput('message', {required: true, trimWhitespace: true})
    const org = core.getInput('org', {required: true, trimWhitespace: true})
    const repo = core.getInput('repo', {required: true, trimWhitespace: true})
    const token = core.getInput('token', {required: true, trimWhitespace: true})

    core.debug(`Running the "${action}" action.`)

    const client = await newClient(token)

    if (action === 'notify' || action === 'audit') {
        const exceptedUsers = await retrieveUsersFromAuditLog(client, org, days)
        const nonCompliantUsers = await getOffendingUsers(client, org)
        const violations = await intersect(exceptedUsers, nonCompliantUsers)

        console.log(`Found ${violations.length} violations`)
        
        if (action === 'audit') {
            process.exit(0)
        }

        for (const user of violations.sort()) {
            await processUser(client, org, repo, user, message)
        }
    } else if (action === 'reconcile') {
        const issues = await retrieveIssues(client, org, repo)
        for (const issue of issues) {
            await processIssue(client, org, repo, issue)
        }
    }
})()
