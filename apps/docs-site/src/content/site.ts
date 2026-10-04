// Site contact configuration.
//
// GitHub identity is live (supplied for the open-source release).
// Email remains a documented placeholder: no owner mailbox has been
// supplied, so the site must never render a mailto link. GitHub Issues
// is the primary public contact route until a real address lands here.
// To supply it, edit exactly this file:
//   - CONTACT.emailUser / emailDomain → the real mailbox
//   - CONTACT.emailConfigured → true
// Every contact affordance on the site derives from here.

export const CONTACT = {
  emailUser: "hello",
  emailDomain: "example.invalid",
  emailSubject: "Atlas feedback",
  emailConfigured: false,
  githubUrl: "https://github.com/Ankit95040/Atlas",
  issuesUrl: "https://github.com/Ankit95040/Atlas/issues",
} as const;
