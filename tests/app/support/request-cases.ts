export const linkError = "Link is invalid. Use a URL like https://example.com, or leave Link empty.";

export const invalidRequests = [
  { name: "no selected channels", body: { platforms: [] }, error: "Select at least one channel." },
  { name: "whitespace-only text", body: { text: " \n " }, error: "Write post text, or add a title for title-only channels." },
  { name: "Hacker News without title", body: { platforms: ["hackernews"] }, error: "Hacker News requires a title." },
  { name: "YouTube without title", body: { platforms: ["youtube"] }, error: "YouTube requires a title." },
  { name: "Dribbble without title", body: { platforms: ["dribbble"] }, error: "Dribbble requires a title." },
  { name: "title over generic request bound", body: { title: "a".repeat(301) }, error: "String must contain at most 300 character(s)" },
  { name: "title over provider bound", body: { title: "a".repeat(81), platforms: ["hackernews"] }, error: "Hacker News title is 81/80 characters. Shorten the title or deselect Hacker News." },
  { name: "text over provider bound", body: { text: "a".repeat(301) }, error: "Bluesky post is 301/300 characters. Shorten the post or deselect Bluesky." },
  { name: "link error before title and text errors", body: { linkUrl: "https://intranet", title: "a".repeat(301), text: "a".repeat(301) }, error: linkError },
  { name: "title error before text error", body: { title: "a".repeat(301), text: "a".repeat(301) }, error: "String must contain at most 300 character(s)" }
];

export const linkCases = [
  { input: " example.com/article ", normalized: "https://example.com/article" },
  { input: "http://localhost:2004/article", normalized: "http://localhost:2004/article" },
  { input: " \n ", normalized: undefined },
  { input: "https://user:secret@example.com", error: linkError },
  { input: "ftp://example.com", error: linkError },
  { input: "https://intranet", error: linkError },
  { input: "not a url", error: linkError },
  { input: 123, error: linkError }
];
