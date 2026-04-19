/**
 * Pure helper for PickFolderScreen — guesses the IMAP folder that
 * holds the Curve receipt emails, based only on the folder names
 * returned by IMAP LIST.
 *
 * Rules (in order):
 *   1. Any folder whose lowercased name contains "curve";
 *      deepest path wins so "Finanças/Curve" beats "Curve".
 *   2. Otherwise, any folder containing "receipt" or "recib" (PT).
 *   3. Otherwise, "INBOX" if present (case-insensitive).
 *   4. Otherwise, the first folder.
 *   5. Empty input → "INBOX" as an "it'll resolve on the server" fallback.
 *
 * Kept in a separate `.js` file (not `.jsx`) so the server-side smoke
 * test (`server/scripts/test-suggest-receipts-folder.js`) can import
 * it via plain Node without a JSX loader.
 */
export function suggestReceiptsFolder(folders) {
  if (!Array.isArray(folders) || folders.length === 0) return 'INBOX';

  const deepest = (regex) => {
    const matches = folders.filter((f) => regex.test(f.toLowerCase()));
    if (matches.length === 0) return null;
    // Longest path wins — a nested "Finanças/Curve" is a stronger
    // signal than a top-level "Curve" that might just be a stub.
    return [...matches].sort((a, b) => b.length - a.length)[0];
  };

  return (
    deepest(/curve/) ||
    deepest(/receipt|recib/) ||
    folders.find((f) => f.toLowerCase() === 'inbox') ||
    folders[0]
  );
}
