/**
 * "#12" written in a text is a reference to task 12, unless it is part of a
 * word, an address or an entity. RichView shows it as a link, and the server
 * finds the tasks a text mentions by the same pattern.
 */
export const TASK_REF = /(?<![\p{L}\p{N}_/#&])#(\d{1,9})(?![\p{L}\p{N}_])/gu;
