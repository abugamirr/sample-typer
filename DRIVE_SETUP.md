# Setting up Google Drive sync

Sample Typer can sync every draft to Google Drive as a real, editable Google
Doc, live as you type. To turn it on, you need your own Google OAuth Client
ID — Google requires this to be registered per app/origin, so it can't be
baked into the codebase. It takes about five minutes.

## 1. Create (or pick) a Google Cloud project

Go to [console.cloud.google.com](https://console.cloud.google.com/) and
create a new project (or reuse an existing one). Any name is fine.

## 2. Enable the Google Drive API

In the project, go to **APIs & Services → Library**, search for
**Google Drive API**, and click **Enable**.

## 3. Configure the OAuth consent screen

Go to **APIs & Services → OAuth consent screen**.

- User type: **External** is fine for personal use.
- Fill in the required app name / support email fields.
- Leave publishing status as **Testing** — you don't need to submit for
  verification. In Testing mode, add your own Google account under
  **Test users** so it's allowed to sign in.
- Scopes: you don't need to add anything here manually — the app requests
  `drive.file` at sign-in time, which only grants access to files *this app
  creates*, not your whole Drive.

## 4. Create the OAuth Client ID

Go to **APIs & Services → Credentials → Create Credentials → OAuth client
ID**.

- Application type: **Web application**.
- **Authorized JavaScript origins**: add the origin(s) you'll run the app
  from, e.g. `http://localhost:5173` for `npm run dev`, plus your production
  URL if you deploy it somewhere.
- **Authorized redirect URIs**: leave empty — this app uses Google Identity
  Services' token flow, which doesn't redirect.

Click **Create** and copy the Client ID it gives you (looks like
`123456789-abc...apps.googleusercontent.com`).

## 5. Add it to the app

Copy `.env.example` to `.env` in this folder, and paste your Client ID in:

```
VITE_GOOGLE_CLIENT_ID=123456789-abc...apps.googleusercontent.com
```

Restart `npm run dev` (Vite only reads `.env` at startup).

## 6. Connect

Open the app, click **Connect Google Drive** in the sidebar footer, and
approve the Google consent screen. A **Sample Typer** folder will appear in
your Drive, and each draft you write will sync into it as a native Google
Doc — click **Docs ↗** in the top bar to open the current draft directly in
Google Docs.

## Notes

- Scope is `drive.file`: the app can only see and edit files it created
  itself, never anything else already in your Drive.
- Sync fires ~2 seconds after you stop typing, on top of the app's own local
  autosave — so a short pause is enough to push, but rapid typing won't spam
  the Drive API.
- The **Backup all** button is unrelated and still works independently — it
  downloads a plain `.json` snapshot of your whole library for a manual,
  portable backup.
