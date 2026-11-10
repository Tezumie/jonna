// Unique ids for sessions, items, requests (time-based + counter; no randomness needed).
let counter = 0;
export const newId = (prefix = "a") =>
  `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}`;
