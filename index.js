const fs = require('fs')
const core = require('@actions/core')
const handlebars = require('handlebars')
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
    return users.filter((user) => user.organizationVerifiedDomainEmails.length === 0).map((user) => user.login)
}

async function openIssue(client, org, repo, user, days, message) {
    let issues
    try {
        console.log(`Searching for existing issue for ${user}`)
        issues = await client.paginate(client.issues.listForRepo, {
            owner: org,
            repo: repo,
            assignee: user,
            labels: ['compliance-unverified-email'],
            state: 'all',
            per_page: 100
        })

        if (issues.length > 0) {
            const date = new Date()
            const created = new Date(issues[0].created_at)
            if (date.getTime() - created.getTime() > days * 24 * 60 * 60 * 1000) {
                console.log(`Closing existing issue for ${user}`)
                await client.issues.update({
                    owner: org,
                    repo: repo,
                    issue_number: issues[0].number,
                    state: 'closed'
                })

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
        console.log(err.message)
    }


}

(async function main() {
    const days = parseInt(core.getInput('days', {required: true, trimWhitespace: true}))
    const org = core.getInput('org', {required: true, trimWhitespace: true})
    const repo = core.getInput('repo', {required: true, trimWhitespace: true})
    const token = core.getInput('token', {required: true, trimWhitespace: true})
    const body = core.getInput('message', {required: true, trimWhitespace: true})
    const client = await newClient(token)
    const users = await getOffendingUsers(client, org)
    for (const user of users) {
        const message = handlebars.compile(body)({org, repo, user})
        await openIssue(client, org, repo, user, days, message)
    }
})()