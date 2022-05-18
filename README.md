# warden-audit-domain

Audits a GitHub organization for users that have email addresses with non-verified domains.

## Usage

```yml
- uses: lindluni/warden-audit-domain@main
  with:
    # The action to perform. One of: notify, reconcile or audit.
    #
    # 'notify' - Notifies non-compliant users with an issue.
    # 'reconcile' - Removes non-compliant users from the organization. 
    # 'audit' - Logs the count of non-compliant users.
    #
    # Default: notify
    action: ''
    
    # Number of days to allow non-compliant users to stay in the org.  
    # Defaults to 14.
    days: ''
    
    # Issue body for the notification.
    message: ''
    
    # Repository where notification issues are created.
    repo: ''
    
    # Organization to audit.  
    # Defaults to the ${{ github.repository_owner }}.
    org: ''
    
    # GitHub Admin PAT to open issues and comment.  
    # Defaults to the ${{ github.token }}
    token: ''
```
