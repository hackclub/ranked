import type { GitHubConnection } from "@/app/lib/session";

const githubHeaders = (token: string) => ({
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": "2022-11-28",
  "Content-Type": "application/json",
});

// The app's slug (its URL name on github.com), not its client id — the two
// are unrelated and only the slug can build an installation URL. Kept
// overridable so a staging deployment can point at its own app.
const GITHUB_APP_SLUG = process.env.GITHUB_APP_SLUG ?? "hack-club-ranked";

// Where a player has to go for the app to actually gain access to their
// repo. Authorizing the app (githubAuthorizationUrl below) and installing it
// are two separate things on GitHub's side: authorizing only proves who they
// are, while installing is what grants repository permissions. Authorizing
// alone yields a user access token that can read /user perfectly well but
// cannot see a single repo — which is why a player could finish onboarding
// looking connected and only discover at publish time that nothing could be
// committed. So this, not the authorize URL, is the front door.
export function githubInstallUrl(state?: string) {
  const params = state ? `?${new URLSearchParams({ state })}` : "";
  return `https://github.com/apps/${GITHUB_APP_SLUG}/installations/new${params}`;
}

// The list of every app a player has installed — only a fallback, for when
// the installation's own id isn't known. It makes them hunt for Ranked among
// their apps and then find Configure, so prefer the per-installation URL
// below wherever the id is to hand.
export const GITHUB_INSTALLATION_SETTINGS_URL =
  "https://github.com/settings/installations";

// The installation's own settings page, which is where the "Review request"
// prompt for permissions the app has since added actually appears — the one
// click a player needs, instead of a list to search.
export const githubInstallationSettingsUrl = (installationId?: number) =>
  installationId
    ? `https://github.com/settings/installations/${installationId}`
    : GITHUB_INSTALLATION_SETTINGS_URL;

// GITHUB_CLIENT_ID/SECRET here are a GitHub App's "user authorization" OAuth
// credentials, not a classic OAuth App's — deliberately, so the resulting
// user access token is scoped to only whatever repos the player granted the
// app during installation (just their own hackclubranked repo), instead of
// the old "repo" scope's account-wide write access. There's no `scope`
// param to send: a GitHub App's permissions are fixed on the app itself, not
// negotiated per authorization request the way an OAuth App's are.
export function githubAuthorizationUrl(
  state: string,
  challenge: string,
  redirectUri: string,
) {
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId) throw new Error("GITHUB_CLIENT_ID is required.");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: process.env.GITHUB_REDIRECT_URI ?? redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `https://github.com/login/oauth/authorize?${params}`;
}

// `verifier` is null for a code minted by the install-then-authorize flow:
// the installation URL has nowhere to carry a code_challenge, so there is no
// challenge for a verifier to answer and sending one anyway fails the
// exchange. Codes from githubAuthorizationUrl still carry their PKCE pair.
export async function exchangeGitHubCode(
  code: string,
  verifier: string | null,
  redirectUri: string,
) {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret)
    throw new Error("GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are required.");
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      ...(verifier ? { code_verifier: verifier } : {}),
      redirect_uri: process.env.GITHUB_REDIRECT_URI ?? redirectUri,
    }),
  });
  const token = (await response.json()) as GitHubTokenResponse;
  if (!response.ok || !token.access_token)
    throw new Error(token.error_description ?? "GitHub token exchange failed.");
  const userResponse = await fetch("https://api.github.com/user", {
    headers: githubHeaders(token.access_token),
  });
  if (!userResponse.ok)
    throw new Error(`GitHub profile request failed (${userResponse.status}).`);
  const user = (await userResponse.json()) as {
    login: string;
    avatar_url?: string;
  };
  return {
    accessToken: token.access_token,
    login: user.login,
    avatarUrl: user.avatar_url ?? null,
    refreshToken: token.refresh_token ?? null,
    accessTokenExpiresAt: expiresAt(token.expires_in),
    refreshTokenExpiresAt: expiresAt(token.refresh_token_expires_in),
  };
}

type GitHubTokenResponse = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
};

const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

function expiresAt(seconds: number | undefined) {
  return typeof seconds === "number" && Number.isFinite(seconds)
    ? Date.now() + seconds * 1000
    : null;
}

export class GitHubCredentialsError extends Error {}

// GitHub App user access tokens expire after eight hours by default. Their
// refresh tokens rotate on every use, so callers must persist the returned
// connection whenever this function produces a new object.
//
// A user access token's permission scope is fixed at the moment it's issued
// — accepting an installation's updated permissions on GitHub doesn't
// upgrade tokens already handed out, only ones minted afterward. `force`
// skips the expiry check so a token can be reissued (and thus pick up a
// just-accepted permission) well before its natural 8-hour expiry would
// otherwise trigger a refresh.
export async function refreshGitHubConnection(
  connection: GitHubConnection,
  options?: { force?: boolean },
): Promise<GitHubConnection> {
  if (
    !options?.force &&
    (!connection.accessTokenExpiresAt ||
      connection.accessTokenExpiresAt > Date.now() + TOKEN_REFRESH_SKEW_MS)
  ) {
    return connection;
  }
  if (
    !connection.refreshToken ||
    (connection.refreshTokenExpiresAt &&
      connection.refreshTokenExpiresAt <= Date.now())
  ) {
    throw new GitHubCredentialsError(
      "Your GitHub connection expired. Reconnect GitHub and try publishing again.",
    );
  }

  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are required.");
  }
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: connection.refreshToken,
    }),
  });
  const token = (await response.json()) as GitHubTokenResponse;
  if (!response.ok || !token.access_token) {
    throw new GitHubCredentialsError(
      token.error_description ??
        "Your GitHub connection could not be refreshed. Reconnect GitHub and try again.",
    );
  }

  return {
    ...connection,
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? connection.refreshToken,
    accessTokenExpiresAt: expiresAt(token.expires_in),
    refreshTokenExpiresAt: expiresAt(token.refresh_token_expires_in),
  };
}

// Thrown when the player's hackclubranked repo doesn't exist yet, or exists
// but the Ranked GitHub App's installation doesn't cover it — GitHub returns
// a 404 for both (it doesn't distinguish "doesn't exist" from "exists but
// you can't see it", to avoid leaking the existence of private repos). The
// fix is the same either way: create the repo from the template and/or grant
// the app access to it, so both cases share one specific, actionable error.
export class GitHubRepoNotAccessibleError extends Error {}

// Thrown for a 403 whose cause is the installation not having accepted one
// of the app's repository permissions yet — enabling Pages (Pages +
// Administration) or committing a build (Contents). Keep this separate from
// a generic GitHub error so the UI can send the player to the installation
// settings instead of displaying GitHub's opaque 403 response.
export class GitHubPermissionError extends Error {}

async function githubRequest<T>(
  token: string,
  url: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { ...githubHeaders(token), ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    const detail = await response.text();
    if (response.status === 401) {
      throw new GitHubCredentialsError(
        "Your GitHub authorization is no longer valid. Reconnect GitHub and try publishing again.",
      );
    }
    throw new Error(
      `GitHub request failed (${response.status}): ${detail.slice(0, 280)}`,
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

const RANKED_REPO = "hackclubranked";
const isNotFound = (error: unknown) =>
  error instanceof Error && error.message.includes("(404)");

// The session caches the GitHub login from whenever the account was first
// connected. If it's ever renamed on GitHub afterward, that cached login
// becomes permanently wrong for the rest of the session — every existence
// check against it 404s forever, even though the repo is really there under
// the account's current name. Refetching right before anything that needs
// to be correct avoids trusting a value that can go stale for weeks.
async function currentGitHubLogin(token: string) {
  const user = await githubRequest<{ login: string }>(
    token,
    "https://api.github.com/user",
  );
  return user.login;
}

// The three repository permissions publishing actually exercises: Contents
// for the build commit, and Pages + Administration together because GitHub
// requires both to create a Pages site. Metadata (read) is mandatory for
// every GitHub App and never needs asking for.
const REQUIRED_INSTALLATION_PERMISSIONS: Record<string, "write"> = {
  contents: "write",
  pages: "write",
  administration: "write",
};

export type RankedAccessProblem =
  // The app was authorized but never installed, so its user token can't see
  // a single repository. This is the one that used to go unnoticed until
  // publish time, because authorizing alone is enough for /user to work.
  | "not_installed"
  // Installed, but at permissions narrower than the app now asks for —
  // GitHub keeps an installation on its old permissions until the owner
  // accepts the new ones, so an app whose Contents scope was added after
  // they installed still cannot commit.
  | "permissions_pending"
  // Installed with the right permissions, but not pointed at (or missing) a
  // hackclubranked repo. GitHub can't distinguish the two — see
  // GitHubRepoNotAccessibleError.
  | "repo_not_accessible";

export type RankedAccessStatus = {
  login: string;
  problem: RankedAccessProblem | null;
  missingPermissions: string[];
  installUrl: string;
  // Points at the installation itself once one is found, and at the list of
  // installed apps when there is none to point at.
  settingsUrl: string;
  installationId?: number;
  // Exactly what GitHub reported for the installation, so a disagreement
  // between this check and GitHub's own UI can be read off the response
  // instead of guessed at.
  grantedPermissions?: Record<string, string> | null;
};

type UserInstallation = {
  id: number;
  app_slug?: string;
  target_type?: string;
  account?: { login?: string; type?: string } | null;
  permissions?: Record<string, string>;
};

// Answers "can this connection actually publish?" without publishing, so
// onboarding can insist on a working installation instead of letting a
// player reach the end of a match before finding out. Every call here is
// cheap and needs no repository permission of its own.
export async function rankedAccessStatus(
  token: string,
  sessionLogin: string,
): Promise<RankedAccessStatus> {
  const login = await currentGitHubLogin(token).catch(() => sessionLogin);
  const base = {
    login,
    missingPermissions: [] as string[],
    installUrl: githubInstallUrl(),
    settingsUrl: GITHUB_INSTALLATION_SETTINGS_URL,
  };

  const { installations } = await githubRequest<{
    installations: UserInstallation[];
  }>(token, "https://api.github.com/user/installations?per_page=100");
  // This endpoint lists every installation the player can *see*, not just
  // their own — the app installed on the Hack Club org shows up for every
  // member of it. Matching on the app alone could therefore pick the org's
  // installation: the wrong id to link to (an org installation lives under
  // /organizations/<org>/settings/installations, not /settings), and the
  // wrong set of permissions to check, which manufactures a pending
  // approval that has nothing to approve. A player's hackclubranked repo is
  // always on their personal account, so their own installation is the only
  // one that can grant access to it.
  const installation = installations.find(
    (candidate) =>
      candidate.app_slug === GITHUB_APP_SLUG &&
      candidate.target_type === "User" &&
      candidate.account?.login?.toLowerCase() === login.toLowerCase(),
  );
  // An org installation without a personal one isn't "installed" for these
  // purposes — it can't reach their own repo.
  if (!installation) return { ...base, problem: "not_installed" };

  // Every remaining answer is about this specific installation, so point at
  // it directly from here on.
  const installed = {
    ...base,
    installationId: installation.id,
    settingsUrl: githubInstallationSettingsUrl(installation.id),
  };

  // An installation whose permissions map came back absent or empty tells us
  // nothing, and must not be read as "every permission is missing" — that
  // sends players to approve a request GitHub never made, onto a page with
  // no Review request button to click and nothing they can do. Only a map we
  // positively read says anything: GitHub lists every granted permission in
  // it, so within a populated map an absent key really is absent.
  const granted = installation.permissions;
  const missingPermissions =
    granted && Object.keys(granted).length
      ? Object.keys(REQUIRED_INSTALLATION_PERMISSIONS)
          .filter(
            (name) => granted[name] !== "write" && granted[name] !== "admin",
          )
          .sort()
      : [];
  if (missingPermissions.length) {
    return {
      ...installed,
      missingPermissions,
      grantedPermissions: granted ?? null,
      problem: "permissions_pending",
    };
  }

  try {
    await githubRequest(
      token,
      `https://api.github.com/repos/${login}/${RANKED_REPO}`,
    );
  } catch (error) {
    if (isNotFound(error))
      return {
        ...installed,
        grantedPermissions: granted ?? null,
        problem: "repo_not_accessible",
      };
    throw error;
  }
  return { ...installed, grantedPermissions: granted ?? null, problem: null };
}

export type RankedPublishBlock = {
  error: string;
  code: "github_install_required";
  problem: RankedAccessProblem | "not_connected";
  missingPermissions: string[];
  installUrl: string;
  settingsUrl: string;
};

const BLOCK_MESSAGES: Record<RankedAccessProblem | "not_connected", string> = {
  not_connected:
    "Connect GitHub and install the Ranked app on your hackclubranked repo before joining a match.",
  not_installed:
    "The Ranked GitHub App isn't installed on your account yet, so a finished match couldn't be published. Install it on your hackclubranked repo first.",
  permissions_pending:
    "Your Ranked GitHub App installation is still on its older permissions and can't commit builds. Approve the updated ones before joining a match.",
  repo_not_accessible:
    "The Ranked GitHub App can't see a hackclubranked repo on your account. Create it and grant the app access before joining a match.",
};

const publishBlock = (
  problem: RankedAccessProblem | "not_connected",
  access?: Pick<RankedAccessStatus, "missingPermissions" | "settingsUrl">,
): RankedPublishBlock => ({
  error: BLOCK_MESSAGES[problem],
  code: "github_install_required",
  problem,
  missingPermissions: access?.missingPermissions ?? [],
  installUrl: githubInstallUrl(),
  settingsUrl: access?.settingsUrl ?? GITHUB_INSTALLATION_SETTINGS_URL,
});

// Null when a player can publish (or when we can't tell), and the blocking
// body when they can't. Publishing is the last step of every match, so
// matchmaking asks this before handing out a match instead of letting the
// answer arrive when the timer has already run out, the opponent is waiting
// on the publication for voting to open, and there's nothing to be done
// about it in the moment.
//
// Anything short of a definite "no" lets them through: matchmaking must
// never be held closed by a GitHub outage.
export async function rankedPublishBlock(
  connection: GitHubConnection | undefined,
): Promise<RankedPublishBlock | null> {
  if (!connection) return publishBlock("not_connected");
  // Deliberately not refreshed. Refresh tokens rotate on every use, so
  // refreshing obliges the caller to persist the new one or the next refresh
  // fails with a spent token — not something a route with many exits can
  // thread a Set-Cookie through reliably. A token too old to check with
  // simply isn't checked: /api/github/installation refreshes and persists
  // properly on page load, so by the time someone readies up theirs is
  // almost always current, and publishing refreshes on its own regardless.
  if (
    connection.accessTokenExpiresAt &&
    connection.accessTokenExpiresAt <= Date.now() + 60_000
  ) {
    return null;
  }
  try {
    const access = await rankedAccessStatus(
      connection.accessToken,
      connection.login,
    );
    return access.problem ? publishBlock(access.problem, access) : null;
  } catch (error) {
    // A token GitHub itself rejects is a real blocker — that has to be
    // reconnected before a match, not after one.
    if (error instanceof GitHubCredentialsError)
      return publishBlock("not_connected");
    console.error("publish readiness check failed", error);
    return null;
  }
}

function repoContentsPath(login: string, path = "") {
  return `https://api.github.com/repos/${login}/${RANKED_REPO}/contents/${path}`;
}

async function pathExists(token: string, login: string, path: string) {
  try {
    await githubRequest(token, repoContentsPath(login, path));
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function configureRankedRepoForPages(
  token: string,
  login: string,
) {
  // .nojekyll itself is committed alongside the build's own files in
  // commitFiles (see publishWebsite) rather than PUT here on its own — that
  // used to cost every publish an extra standalone commit just to re-affirm
  // a file that, after the first publish, never actually changes. Only the
  // repo settings call (not a content commit) belongs here.
  //
  // Do not blindly POST on every publish. That endpoint requires both Pages
  // write and Administration write, while checking an already-enabled site
  // only needs Pages read. This lets existing Pages sites keep publishing
  // without needlessly exercising the broader administration permission.
  try {
    await githubRequest(
      token,
      `https://api.github.com/repos/${login}/${RANKED_REPO}/pages`,
    );
    return;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  // A repo freshly created from the template (or an app installation just
  // granted) can take a moment for its `main` branch to become visible to
  // GitHub's Pages service specifically — enabling Pages right after can 404
  // on that race alone. Retrying a few times beats surfacing that as a
  // publish failure when the repo itself is already there and fine.
  for (let attempt = 1; ; attempt++) {
    try {
      await githubRequest(
        token,
        `https://api.github.com/repos/${login}/${RANKED_REPO}/pages`,
        {
          method: "POST",
          body: JSON.stringify({ source: { branch: "main", path: "/" } }),
        },
      );
      return;
    } catch (error) {
      if (error instanceof Error && error.message.includes("409")) return;
      if (error instanceof Error && error.message.includes("(403)")) {
        // GitHub's own detail text is the only way to tell "installation
        // hasn't accepted the Pages/Administration scopes" apart from other
        // 403 causes the app permissions can't fix (e.g. an org policy
        // blocking Pages, or a private repo on a plan that doesn't support
        // it) — surface it instead of assuming which one this is.
        console.error("Pages creation 403:", error.message);
        throw new GitHubPermissionError(
          `GitHub Pages could not be enabled: ${error.message.replace(/^GitHub request failed \(403\): ?/, "")} If this doesn't mention a plan or policy restriction, approve the Ranked GitHub App's Pages/Administration permissions and publish again.`,
        );
      }
      if (
        error instanceof Error &&
        error.message.includes("(404)") &&
        attempt < 5
      ) {
        await sleep(attempt * 500);
        continue;
      }
      throw error;
    }
  }
}

// Every player's builds live in one repo on their own account, one folder
// per match — but unlike the old "repo" OAuth scope, a GitHub App's user
// token can only see repos its installation was actually granted. This only
// ever fetches: the app's Administration permission is restricted to that
// selected repo and is used solely to enable Pages, not to create repos.
async function ensureRankedRepo(token: string, login: string) {
  let repository: { html_url: string };
  try {
    repository = await githubRequest<{ html_url: string }>(
      token,
      `https://api.github.com/repos/${login}/${RANKED_REPO}`,
    );
  } catch (error) {
    if (isNotFound(error)) {
      throw new GitHubRepoNotAccessibleError(
        `You don't have a "${RANKED_REPO}" repo the Ranked GitHub App can see yet — create one from the template, then make sure the app has access to it.`,
      );
    }
    throw error;
  }
  await configureRankedRepoForPages(token, login);
  return repository;
}

const RESERVED_FOLDER_NAMES = ["index.html", "readme.md", ".nojekyll"];
export const PUBLISHABLE_FILE_NAME =
  /^[A-Za-z0-9][A-Za-z0-9._-]*\.(html|css|js)$/;

const isRefUpdateFailure = (error: unknown) =>
  error instanceof Error &&
  (error.message.includes("(409)") || error.message.includes("(422)"));

// Commits every entry in `files` (path -> content) as ONE commit on main,
// via the Git Data API (tree + commit + ref update) instead of the Contents
// API's per-file PUT — a PUT creates its own commit each time, so publishing
// a build with a handful of pages, a README, css/js sources, .nojekyll, and
// the root directory listing used to cost 6-8+ separate commits for one
// publish. Building one tree with every changed path lands them all at once.
async function commitFiles(
  token: string,
  login: string,
  files: Record<string, string>,
  message: string,
) {
  const refUrl = `https://api.github.com/repos/${login}/${RANKED_REPO}/git/ref/heads/main`;
  const treesUrl = `https://api.github.com/repos/${login}/${RANKED_REPO}/git/trees`;
  const commitsUrl = `https://api.github.com/repos/${login}/${RANKED_REPO}/git/commits`;
  const updateRefUrl = `https://api.github.com/repos/${login}/${RANKED_REPO}/git/refs/heads/main`;
  const entries = Object.entries(files).map(([path, content]) => ({
    path,
    mode: "100644",
    type: "blob",
    content,
  }));
  // Retries against a freshly-read base if another commit (a concurrent
  // publish landing on main between the read and the write) beat this one to
  // the ref update — the same race the old per-file PUTs could hit, but now
  // there's one ref update to retry instead of several.
  for (let attempt = 1; ; attempt++) {
    try {
      const ref = await githubRequest<{ object: { sha: string } }>(
        token,
        refUrl,
      );
      const baseCommitSha = ref.object.sha;
      const baseCommit = await githubRequest<{ tree: { sha: string } }>(
        token,
        `https://api.github.com/repos/${login}/${RANKED_REPO}/git/commits/${baseCommitSha}`,
      );
      const tree = await githubRequest<{ sha: string }>(token, treesUrl, {
        method: "POST",
        body: JSON.stringify({ base_tree: baseCommit.tree.sha, tree: entries }),
      });
      const commit = await githubRequest<{ sha: string }>(token, commitsUrl, {
        method: "POST",
        body: JSON.stringify({
          message,
          tree: tree.sha,
          parents: [baseCommitSha],
        }),
      });
      try {
        await githubRequest(token, updateRefUrl, {
          method: "PATCH",
          body: JSON.stringify({ sha: commit.sha }),
        });
        return;
      } catch (error) {
        if (!isRefUpdateFailure(error) || attempt >= 3) throw error;
      }
    } catch (error) {
      // Same cause as the Pages 403 above, just against the Contents
      // permission instead of Pages/Administration — the installation
      // hasn't accepted it yet, or accepted it after this token was issued.
      if (error instanceof Error && error.message.includes("(403)")) {
        console.error("Commit 403:", error.message);
        throw new GitHubPermissionError(
          `GitHub could not save your build: ${error.message.replace(/^GitHub request failed \(403\): ?/, "")} If this doesn't mention a plan or policy restriction, approve the Ranked GitHub App's Contents permissions and publish again.`,
        );
      }
      throw error;
    }
  }
}

export async function publishWebsite(
  token: string,
  sessionLogin: string,
  requestedName: string,
  theme: string,
  pages: Record<string, string>,
  sourceFiles: Record<string, string> | undefined,
  description: string | undefined,
  existingBuilds: DirectoryBuild[],
) {
  const folderName = requestedName.trim();
  if (
    !/^[A-Za-z0-9._-]{1,100}$/.test(folderName) ||
    folderName === "." ||
    folderName === ".."
  ) {
    throw new Error(
      "Build names may only use letters, numbers, periods, underscores, and hyphens.",
    );
  }
  if (RESERVED_FOLDER_NAMES.includes(folderName.toLowerCase())) {
    throw new Error(`"${folderName}" is reserved. Choose another build name.`);
  }
  if (!pages["index.html"]) {
    throw new Error("An index.html page is required.");
  }
  // The session's cached login can go stale (see currentGitHubLogin above);
  // refresh it so everything below acts on the account's real current name
  // instead of risking a repeat of that mismatch. Falls back to the cached
  // value only if this one extra call itself fails, so a transient hiccup
  // here doesn't block publishing entirely.
  const login = await currentGitHubLogin(token).catch(() => sessionLogin);
  const repository = await ensureRankedRepo(token, login);
  if (await pathExists(token, login, folderName)) {
    throw new Error(
      `"${folderName}" is already used in your ${RANKED_REPO} repo. Choose another name.`,
    );
  }

  const files: Record<string, string> = { ".nojekyll": "" };

  for (const [name, content] of Object.entries(pages)) {
    if (!PUBLISHABLE_FILE_NAME.test(name) || !name.endsWith(".html")) continue;
    files[`${folderName}/${name}`] = content;
  }
  const trimmedDescription = description?.trim();
  files[`${folderName}/README.md`] =
    `# ${folderName}\n\n${trimmedDescription ? `${trimmedDescription}\n\n` : ""}This website was built live on [Hack Club Ranked](https://ranked.hackclub.com).\n`;
  // .html source is skipped here — the bundled version above already covers
  // it, so keeping the raw copy too would just duplicate every page. .css/.js
  // still need their unbundled originals (the pages above only carry them
  // inlined), sorted into styles/ and scripts/ instead of one flat "source".
  for (const [name, content] of Object.entries(sourceFiles ?? {})) {
    if (!PUBLISHABLE_FILE_NAME.test(name) || name.endsWith(".html")) continue;
    const subfolder = name.endsWith(".css") ? "styles" : "scripts";
    files[`${folderName}/${subfolder}/${name}`] = content;
  }

  // The root directory listing folds into this same commit too — it used to
  // be a separate PUT (and thus a separate commit) after the fact. Existing
  // entries are re-checked against the repo (rather than trusted from the
  // database) since there's no in-app unpublish: the only way a listed
  // folder goes missing is someone deleting it directly on GitHub, and
  // without this check the gallery would keep linking to it forever. The
  // build landing in *this* commit obviously doesn't need that check yet.
  const checkedExisting = await Promise.all(
    existingBuilds.map(async (build) => ({
      build,
      exists: await pathExists(token, login, build.folderName),
    })),
  );
  const liveBuilds: DirectoryBuild[] = [
    { folderName, theme, publishedAt: new Date().toISOString() },
    ...checkedExisting.filter(({ exists }) => exists).map(({ build }) => build),
  ];
  files["index.html"] = renderDirectoryIndex(login, liveBuilds);

  await commitFiles(token, login, files, `Publish ${folderName}`);

  return {
    repositoryUrl: `${repository.html_url}/tree/main/${folderName}`,
    pagesUrl: `https://${login}.github.io/${RANKED_REPO}/${folderName}/`,
    repoName: RANKED_REPO,
    folderName,
  };
}

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );

export type DirectoryBuild = {
  folderName: string;
  theme: string;
  publishedAt: string;
};

const FAVICON_SVG =
  '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
  '<path d="M22 19.2727C22 20.779 20.779 22 19.2727 22H14.7273C13.221 22 12 20.779 12 19.2727V12H19.2727C20.779 12 22 13.221 22 14.7273V19.2727Z" fill="#68C4FF"/>' +
  '<path d="M20 2C21.1046 2 22 2.89543 22 4V7C22 8.10457 21.1046 9 20 9H17C15.8954 9 15 8.10457 15 7V4C15 2.89543 15.8954 2 17 2H20Z" fill="#0C79D8"/>' +
  '<path d="M7 15C8.10457 15 9 15.8954 9 17V20C9 21.1046 8.10457 22 7 22H4C2.89543 22 2 21.1046 2 20V17C2 15.8954 2.89543 15 4 15H7Z" fill="#0C79D8"/>' +
  '<path d="M12 12H4.72727C3.22104 12 2 10.779 2 9.27273V4.72727C2 3.22104 3.22104 2 4.72727 2H9.27273C10.779 2 12 3.22104 12 4.72727V12Z" fill="#2E9EFF"/>' +
  "</svg>";

const EXTERNAL_ICON =
  '<svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7"/><path d="M7 7h10v10"/></svg>';
const CLOCK_ICON =
  '<svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2"/></svg>';

function renderDirectoryIndex(login: string, builds: DirectoryBuild[]) {
  const buildCount = builds.length;
  const cards = builds
    .map((build) => {
      const date = escapeHtml(
        new Date(build.publishedAt).toLocaleDateString("en-US", {
          year: "numeric",
          month: "short",
          day: "numeric",
        }),
      );
      return `
        <li>
          <a class="build-card" href="./${encodeURIComponent(build.folderName)}/">
            <span class="build-card-tag">${escapeHtml(build.theme)}</span>
            <strong class="build-card-name">${escapeHtml(build.folderName)}</strong>
            <span class="build-card-meta">${CLOCK_ICON}${date}</span>
            <span class="build-card-cta">open build ${EXTERNAL_ICON}</span>
          </a>
        </li>`;
    })
    .join("");

  const gallery = buildCount
    ? `<ul class="gallery-grid">${cards}
      </ul>`
    : `<div class="empty-state">
        <p>No builds published yet — every match ${escapeHtml(login)} finishes on Hack Club Ranked shows up here as a new card.</p>
        <a class="pill-button" href="https://ranked.hackclub.com">queue up a match ${EXTERNAL_ICON}</a>
      </div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(login)}'s Hack Club Ranked builds</title>
<meta name="description" content="Websites ${escapeHtml(login)} built live on Hack Club Ranked.">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400..900&family=Geist+Mono:wght@400..900&display=swap" rel="stylesheet">
<style>
  :root {
    color-scheme: light;
    --cream: #fff8cf;
    --ink: #20201f;
    --muted: #5c574b;
    --pink: #d891d9;
    --blue: #497cbf;
    --blue-strong: #2f5a8c;
    --green: #ccd96c;
    --orange: #d99f6c;
    --paper: #fffdf0;
    --line: #2c2b29;
    --blob: 255px 20px 225px 20px / 20px 225px 15px 255px;
    --font-sans: "Geist", ui-sans-serif, system-ui, "Segoe UI", sans-serif;
    --font-mono: "Geist Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-width: 320px;
    color: var(--ink);
    font-family: var(--font-sans);
    background-color: var(--cream);
    background-image: radial-gradient(#c7b65c45 0.7px, transparent 0.7px);
    background-size: 17px 17px;
  }
  a:focus-visible, button:focus-visible {
    outline: 3px solid var(--blue);
    outline-offset: 3px;
  }
  .page { max-width: 1180px; margin: 0 auto; padding: 28px 24px 64px; }
  .site-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 14px;
    padding-bottom: 30px;
  }
  .logo {
    display: inline-flex;
    align-items: flex-start;
    gap: 8px;
    text-decoration: none;
    color: var(--ink);
    transform: rotate(-1deg);
  }
  .logo span {
    font-size: 30px;
    line-height: 0.9;
    font-weight: 950;
    letter-spacing: -0.08em;
    transform: scaleX(0.92);
  }
  .logo em {
    font-style: normal;
    font-size: 11px;
    font-weight: 900;
    margin-top: 5px;
    letter-spacing: -0.07em;
  }
  .pill-button {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    border: 2px solid var(--ink);
    background: var(--paper);
    box-shadow: 3px 3px 0 var(--ink);
    padding: 10px 16px;
    font: 650 11px var(--font-mono);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--ink);
    text-decoration: none;
    border-radius: var(--blob);
    transition: transform 0.15s, box-shadow 0.15s;
  }
  .pill-button:hover { background: var(--green); transform: translate(2px, 2px); box-shadow: 1px 1px 0 var(--ink); }
  .pill-button:active { transform: translate(3px, 3px); box-shadow: none; }
  .page-head { max-width: 640px; margin: 8px auto 40px; text-align: center; }
  .build-count-sticker {
    display: inline-block;
    margin-bottom: 14px;
    border: 2px solid var(--ink);
    background: var(--orange);
    padding: 6px 14px;
    font: 800 11px var(--font-mono);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    box-shadow: 3px 3px 0 var(--ink);
    border-radius: var(--blob);
    transform: rotate(-4deg);
  }
  .page-head h1 {
    margin: 4px 0 12px;
    font-size: clamp(34px, 5vw, 58px);
    letter-spacing: -0.065em;
    line-height: 0.95;
  }
  .page-head p {
    margin: 0 auto;
    max-width: 480px;
    font: 450 13px/1.6 var(--font-sans);
    color: var(--muted);
  }
  .gallery-grid {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: clamp(18px, 3vw, 26px);
  }
  .gallery-grid li { display: flex; min-width: 0; }
  .build-card {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-height: 150px;
    border: 2px solid var(--line);
    background: var(--paper);
    box-shadow: 5px 6px 0 #24231f;
    padding: 18px 18px 16px;
    border-radius: var(--blob);
    text-decoration: none;
    color: var(--ink);
    --tilt: -0.5deg;
    transform: rotate(var(--tilt));
    transition: transform 0.15s, box-shadow 0.15s;
  }
  .gallery-grid li:nth-child(even) .build-card { --tilt: 0.45deg; }
  .build-card:hover { transform: translate(3px, 3px) rotate(var(--tilt)); box-shadow: 2px 3px 0 #24231f; }
  .build-card:active { transform: translate(5px, 5px) rotate(var(--tilt)); box-shadow: none; }
  .build-card-tag {
    display: inline-flex;
    max-width: 100%;
    min-width: 0;
    white-space: normal;
    word-break: break-word;
    border: 1.5px solid var(--ink);
    background: var(--cream);
    color: var(--ink);
    padding: 3px 10px;
    font: 700 11px var(--font-mono);
    letter-spacing: -0.01em;
    line-height: 1.4;
    border-radius: var(--blob);
  }
  .gallery-grid li:nth-child(4n+1) .build-card-tag { background: var(--green); }
  .gallery-grid li:nth-child(4n+2) .build-card-tag { background: var(--orange); }
  .gallery-grid li:nth-child(4n+3) .build-card-tag { background: var(--pink); }
  .gallery-grid li:nth-child(4n) .build-card-tag { background: var(--blue-strong); color: var(--cream); border-color: var(--blue-strong); }
  .build-card-name {
    margin: 4px 0 0;
    font: 700 17px var(--font-mono);
    letter-spacing: -0.01em;
    line-height: 1.25;
    word-break: break-word;
  }
  .build-card-meta {
    margin-top: auto;
    display: flex;
    align-items: center;
    gap: 6px;
    font: 600 11px var(--font-mono);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
  }
  .build-card-cta {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-top: 4px;
    padding-top: 10px;
    border-top: 1px dashed #00000022;
    font: 650 11px var(--font-mono);
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--blue-strong);
  }
  .build-card:hover .build-card-cta { color: var(--ink); }
  .empty-state {
    max-width: 480px;
    margin: 20px auto 0;
    text-align: center;
    border: 2px dashed var(--ink);
    background: var(--paper);
    padding: 36px 28px;
    border-radius: var(--blob);
  }
  .empty-state p {
    margin: 0 0 20px;
    font: 500 12px/1.6 var(--font-mono);
    color: var(--muted);
  }
  .site-footer {
    margin-top: 56px;
    padding-top: 20px;
    border-top: 1px dashed #00000022;
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 10px;
    font: 650 11px var(--font-mono);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
  }
  .site-footer a {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--blue);
    text-decoration: none;
  }
  .site-footer a:hover { color: var(--blue-strong); text-decoration: underline; }
  @media (max-width: 760px) {
    .gallery-grid { grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }
  }
  @media (max-width: 480px) {
    .site-header { flex-direction: column; align-items: center; text-align: center; }
    .gallery-grid { grid-template-columns: 1fr; }
    .site-footer { flex-direction: column; align-items: center; text-align: center; }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.01ms !important;
      transition-duration: 0.01ms !important;
    }
  }
</style>
</head>
<body>
<div class="page">
  <header class="site-header">
    <a class="logo" href="https://ranked.hackclub.com" aria-label="Hack Club Ranked home">
      <span>HACK CLUB</span><em>ranked</em>
    </a>
    <a class="pill-button" href="https://ranked.hackclub.com">play a match ${EXTERNAL_ICON}</a>
  </header>
  <main>
    <div class="page-head">
      <span class="build-count-sticker">${buildCount} build${buildCount === 1 ? "" : "s"}</span>
      <h1>@${escapeHtml(login)}</h1>
      <p>Every site ${escapeHtml(login)} has built live on Hack Club Ranked.</p>
    </div>
    ${gallery}
  </main>
  <footer class="site-footer">
    <span>Built live on Hack Club Ranked</span>
    <a href="https://github.com/${escapeHtml(login)}/hackclubranked">view source on GitHub ${EXTERNAL_ICON}</a>
  </footer>
</div>
</body>
</html>
`;
}
