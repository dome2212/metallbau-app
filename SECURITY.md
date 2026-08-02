# Security Policy

## Reporting Security Vulnerabilities

**Please do not open public GitHub issues for security vulnerabilities!**

If you discover a security vulnerability in this project, please email me directly with:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

I will work with you to resolve the issue promptly.

## Security Best Practices

### For Contributors
- Never commit `.env` files with credentials
- Always use environment variables for sensitive data
- Validate and sanitize all user inputs
- Use HTTPS in production
- Keep dependencies updated: `npm audit fix`
- Use strong JWT secrets (minimum 32 characters)
- Hash passwords with bcryptjs (minimum 10 rounds)

### For Users
- Keep your `.env` file secure and never share it
- Use strong, unique passwords
- Enable HTTPS in production
- Regularly update dependencies
- Monitor for security alerts

## Dependencies Security

We use:
- `bcryptjs` for password hashing
- `jsonwebtoken` for secure authentication
- `express` with security middleware
- Regular `npm audit` checks

Run `npm audit` to check for vulnerabilities in your installation.
