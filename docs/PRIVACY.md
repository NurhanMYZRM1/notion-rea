# Privacy summary (draft for store listings)

Draft for App Store privacy labels and Play Data safety. Review before publishing.

**Data collected and linked to the user** (for app functionality only, not for tracking or ads):
- Name, email address and profile photo from Google or Apple sign-in.
- User content: pages, database records, comments, uploaded files.
- Identifiers: account id and session tokens (stored in the device keychain/keystore).

**Not collected:** location, contacts, browsing history, advertising identifiers, analytics SDKs,
crash-report SDKs (none are included).

**On the device:** recently opened documents and workspace metadata are cached in local storage
(IndexedDB on web, SQLite on mobile) for offline use, isolated per account and workspace, bounded to
20 documents / 50 MB, and deleted on sign-out.

**Sharing:** content is visible only to members of the workspace it belongs to and to agent
connections (MCP clients) a member explicitly authorized; there is no public access.

**Deletion:** Settings → Account → Delete account removes the account, sessions, agent connections and
memberships. Content created in a shared workspace stays with that workspace. Sole owners must
transfer ownership first.

**Processors:** Cloudflare (hosting, storage), Google / Apple (sign-in only).
