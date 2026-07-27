# Connecting NicoleBooks to a real QuickBooks company

Source material for the release wave's README. Written from the end user's point of view, in her
own Intuit account. Verified against Intuit's live developer documentation on 2026-07-27; the
"What was verified" section at the bottom records what was checked and what was not.

No em dashes or en dashes anywhere in this file. It feeds public copy.

---

## What you are actually doing, in one paragraph

NicoleBooks talks to QuickBooks through Intuit's developer platform. That means you create a small
"app" on Intuit's developer site, and NicoleBooks uses that app's two keys to sign in to your
QuickBooks company on your behalf. The app is private. Nobody else ever sees it, and it is never
listed in the QuickBooks App Store. Setting it up is a one time job that takes about an hour, most
of which is one questionnaire Intuit requires before it will hand out live keys.

You do this from your own Intuit account so that the connection belongs to you, not to whoever
built the software.

## Before you start

Have these ready:

- The email address you want on the developer account.
- Admin access to the QuickBooks company you want NicoleBooks to enter bills into. You have to be
  an admin of that company to authorize the connection.
- About an hour, in one sitting if possible. Intuit's questionnaire does not always save partway.

## Step 1. Create the Intuit developer account

1. Go to https://developer.intuit.com and sign in, or create an account.
2. You will be asked for basic company information and a name for your **workspace**. The workspace
   is just a container for your apps. Any sensible name is fine.

You can sign in to the developer site with the same Intuit ID you already use for QuickBooks. It is
the same account, wearing a different hat.

## Step 2. Create the app

1. From the toolbar in the upper right, choose **My Hub**, then **App dashboard**.
2. Select the app card with a **+** on it to create a new app.
3. Follow the steps on screen. Give the app a name you will recognize later, for example
   "NicoleBooks".
4. When you are asked which scopes the app needs, choose the **accounting** scope. That is the only
   one NicoleBooks uses.

One thing worth knowing before you click: you can add scopes to an app later, but you cannot remove
them. Pick accounting and nothing else.

## Step 3. Add the two redirect addresses

A redirect address is where Intuit sends your browser after you approve the connection. Intuit
checks it character for character, so it has to be typed exactly.

1. Open your app.
2. In the left menu, choose **Settings**.
3. Open the **Redirect URIs** tab.

You are adding one address to each of two separate lists.

**Development list** (used for testing against Intuit's practice company):

```
http://localhost:8734/oauth/callback
```

**Production list** (used for your real QuickBooks company). Select **Production** first, then add:

```
https://magnetgrouplabs.github.io/nicolebooks/oauth-callback.html
```

Two things that surprise people here:

- The two lists are separate. An address added to one does not appear in the other. Adding only the
  first is the most common reason a live connection fails after everything else looks right.
- The production list will not accept the `http://localhost` address. That is Intuit's rule, not a
  mistake on your part: production redirect addresses have to start with `https`. It is exactly why
  NicoleBooks uses that second address. That page belongs to NicoleBooks, holds nothing, stores
  nothing, and does one thing: it hands the sign in straight back to the copy of NicoleBooks running
  on your computer.

If NicoleBooks ever says **"The Intuit app is missing the NicoleBooks redirect address. Add both
redirect addresses in the Intuit developer portal, then try again."**, this step is the one to come
back to.

## Step 4. Fill in the app details

Intuit will not release live keys until your app has its details filled in. In your app, choose
**Keys and credentials** in the left menu, then select **Production**, then **App details**.

It asks for:

- Your email address and contact details.
- A link to an **End User License Agreement** and a link to a **Privacy Policy**.
- The app's **host domain**, **launch URL**, **disconnect URL**, and **connect or reconnect URL**.
- Up to four **categories** for the app.
- Whether it operates in any **regulated industries**.
- Which **regions** the app is hosted in.

Intuit estimates about 30 minutes for this part.

The URL questions assume your app is a website, and NicoleBooks is a program on your computer. Ask
whoever set up NicoleBooks for you which addresses to use before you start filling this in, so you
are not inventing answers. There is a NicoleBooks page at
`https://magnetgrouplabs.github.io/nicolebooks/` that can serve for the address questions, and the
license and privacy pages can be published there too. Have those links in hand first.

## Step 5. Complete the questionnaire and get the live keys

Still under **Keys and credentials**, with **Production** selected, choose **Compliance**, then
**Start Questionnaire**.

This is Intuit's app assessment. Every app that talks to real QuickBooks data has to pass it, even a
private one used with a single company, so there is no way around it. It is not a test you can fail
by knowing too little; it is a description of how the software handles data, and most of the answers
are about NicoleBooks rather than about you.

The form asks about things like:

- What the app does and who uses it. There is an option that says you are building a private app.
  That is the honest answer here.
- How it signs in and how it handles expired sign ins.
- Which QuickBooks data it reads and writes.
- What it does when a request fails.
- How it stores the keys, and whether anyone has had a security incident.

Get the answers from whoever set NicoleBooks up rather than guessing. Wrong answers here are worth
avoiding, because a flagged questionnaire goes to a human and adds days.

When the questionnaire is approved, go back to **Keys and credentials**, select **Production**, and
turn on the **Show credentials** switch. Your **Client ID** and **Client Secret** are there. Before
approval, that spot shows the questionnaire instead of the keys, which is the clearest sign that
this step is not finished.

Approval is often quick and automatic. It can also be sent for manual review, in which case it takes
longer. Do not plan the switch to live for the same afternoon you fill in the form.

## Step 6. Put the keys into NicoleBooks

1. Open NicoleBooks and go to **Settings**.
2. Scroll to **QuickBooks connection**, then to **QuickBooks app keys**.
3. Paste the production **Client ID** and **Client Secret** into the two fields.
4. Choose **Save QuickBooks keys**.

The keys go straight into your computer's secure keychain. NicoleBooks never shows them again and
never sends them anywhere except to Intuit.

## Step 7. Switch NicoleBooks to Live

In the same **QuickBooks connection** card, find the **QuickBooks company** selector and change it
from **Sandbox (testing)** to **Live QuickBooks**.

Under it you will see: "Live mode connects to a real QuickBooks company. Entries you send will
appear in its books." That is the whole difference between the two settings, and it is worth reading
twice.

If NicoleBooks was already connected to something, it will tell you that switching disconnects the
current QuickBooks company and ask you to confirm. Your saved keys stay put; only the connection
goes.

## Step 8. Connect and authorize

1. Choose **Connect to QuickBooks**.
2. Your normal web browser opens on Intuit's sign in page. Sign in as an **admin of the company you
   want NicoleBooks to use**. If you are signed in to more than one company, check the company name
   on the approval screen before you approve it. This is the step that decides which books get the
   bills.
3. Approve the connection.
4. Your browser flashes through a NicoleBooks page and lands back on a "you can close this tab"
   message. If it sits on that page for more than a couple of seconds, it will tell you what to do
   next. The usual cause is that NicoleBooks was closed while you were signing in.
5. Back in NicoleBooks, the card should now say **Connected to** your company name.

## Step 9. Sync

Choose **Sync now**. NicoleBooks reads your vendor list, your expense categories, your payment
accounts, and your items, and keeps a local copy so the review screen can offer them instantly.

Run this again whenever you add a vendor or a category in QuickBooks itself.

You are done. From here, add bills and review them as usual, and what you approve goes into the real
company.

---

## Testing first, with the practice company

If you would rather rehearse before touching real books, Intuit gives you a free practice company
called a sandbox. Nothing you do in it affects anything real.

1. In the developer site, choose **My Hub**, then **Sandboxes**, then **Add**. Pick QuickBooks
   Online Plus or Advanced, and your country. The country cannot be changed later.
2. Get the **Development** keys from **Keys and credentials** with **Development** selected and the
   **Show credentials** switch on. These are available right away, with no questionnaire.
3. Make sure `http://localhost:8734/oauth/callback` is on the **Development** redirect list from
   step 3.
4. In NicoleBooks, paste the development keys, set the selector to **Sandbox (testing)**, then
   Connect and Sync now.

Everything works the same way. When you are ready for the real thing, switch the selector to Live
and paste the production keys. The two sets of keys are different, so you will paste them again when
you switch.

---

## If something goes wrong

**"The Intuit app is missing the NicoleBooks redirect address."** Step 3. Check the Production list
specifically, and check for a trailing space or a missing `.html`.

**"QuickBooks would not complete the sign in. Check the client id and client secret in Settings."**
The keys and the environment do not match. Development keys only work on Sandbox, production keys
only work on Live.

**"Add your QuickBooks app client id and client secret in Settings, then connect again."** Nothing
has been saved yet, or the keys were saved and then the environment was switched.

**The browser page never returns to NicoleBooks.** NicoleBooks has to be running and open for the
sign in to land. Close the tab, make sure NicoleBooks is open, and choose Connect again.

**Your connection stops working after a long break.** Choose **Reconnect** in Settings. It is the
same sign in, and none of your setup is lost.

---

## What was verified, and when

Checked against Intuit's live developer documentation on 2026-07-27. Anyone updating this file
should re-check, because Intuit renames these screens.

Confirmed current:

- Account and app creation flow, including the workspace prompt and the `My Hub > App dashboard`
  path, and that scopes are chosen at creation and cannot be removed afterwards.
- The keys location is **Keys and credentials** in the left menu, with a Development and Production
  choice and a **Show credentials** switch. Older instructions that describe "Production Settings"
  and "Development Settings" tabs, or a "Keys & OAuth" section, describe a layout Intuit has
  retired. One of Intuit's own pages still shows the old wording; it is stale.
- Redirect addresses live under **Settings**, in a **Redirect URIs** tab, per environment.
- `localhost` without https is explicitly allowed for sandbox, and production redirect addresses
  must begin with `https`, with IP addresses not allowed. This is the constraint the forwarder page
  exists to satisfy.
- Live keys are released only after the questionnaire is approved, and before approval the portal
  shows the questionnaire where the keys would be.
- A private, single company app still has to complete the questionnaire. There is no private-use
  exemption. What a private app does NOT need is the App Store listing and its technical, security,
  and marketing reviews.
- App details requires the EULA link, privacy policy link, host domain, launch URL, disconnect URL,
  connect or reconnect URL, categories, regulated industries, and hosting regions.
- The OAuth endpoints are unchanged and are the SAME for sandbox and production. Which environment
  you are in is decided by which keys sign the request, not by the URL. Only the data host differs.
- Minor version 75 is current, and versions 1 through 74 were discontinued on 2025-08-01.

Worth knowing, though it changes nothing here:

- Every production app is automatically enrolled in Intuit's App Partner Program at the free Builder
  tier, which includes 500,000 metered API calls a month. Only read and query calls are metered;
  creating bills is not, and sandbox calls are never metered. NicoleBooks at a few bills a week is
  nowhere near the limit.

Not verified, so verify in the portal rather than trusting this file:

- The exact button labels inside the app creation wizard. Intuit documents the flow but does not
  show the screen.
- The precise section names inside the questionnaire. Intuit does not publish them. The list in step
  5 is a description of what it covers, taken from a third party walkthrough that matches the current
  navigation, not a transcript.
- How long approval takes. Intuit publishes no turnaround time for the questionnaire. The often
  quoted "about five minutes" comes from a help article that is visibly out of date.
