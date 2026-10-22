---
title: Rova Store Listing
---

*Updated October 21, 2026*

## Basics

These fields are the same in both stores. Character counts are checked against each store's limit.

| Field | Value | Limit |
|---|---|---|
| App name | Rova: GPS & Ticket Alerts | 30 (25 used) |
| Bundle / package ID | com.getrova.app | must match the app build |
| Primary category | Navigation (Apple) · Maps & Navigation (Google) | |
| Secondary category | Utilities (Apple only) | |
| Price | Free, with in-app subscriptions | |
| Support email | getrovaapp@gmail.com | |
| Support URL | https://player-check.onrender.com/privacy | Apple requires one |
| Privacy policy URL | https://player-check.onrender.com/privacy | |
| Terms of use URL | https://player-check.onrender.com/terms | needed for subscriptions |
| Marketing / developer website | https://player-check.onrender.com | AdMob reads app-ads.txt here |
| Age rating | 4+ (Apple) · Everyone (Google) | no mature content, no user chat |
| Content rights | Uses public NYC Open Data and OpenStreetMap data | |
| Copyright | 2026 Rova (switch to the LLC name once formed) | |

Open question: a real Rova website and domain would look better as the support and marketing URL than the Render address.

## Apple App Store

Paste these into App Store Connect. Keywords skip words already in the app name (GPS, ticket), since Apple counts those anyway.

| Field | Text | Limit |
|---|---|---|
| Subtitle | Drive smart. Skip the ticket. | 30 (29 used) |
| Promotional text | New: alerts before NYC late fees hit, AI-written ticket disputes, and instant can-I-park-here answers. Free navigation with camera warnings, no catch. | 170 (150 used) |
| Keywords | parking,nyc,navigation,speed camera,dispute,tow,boot,street cleaning,truck route,fleet,meter,traffic | 100 (100 used) |

### Description

Rova is free GPS navigation built for city drivers, with one thing no other map app does: it watches your plate for tickets and warns you before late fees, judgment and tows hit.

DRIVE

- Turn-by-turn voice directions with live traffic
- Speed and red-light camera alerts along your route
- Road reports from other drivers: crashes, police, construction, closures
- Avoid tolls or highways, add a stop, share your trip and ETA
- Truck mode with NYC truck routes and your height and weight

PARK

- Tap Park for a green, yellow or red answer: can you park here, and until when
- Snap a parking sign and Rova reads it for you
- Save where you parked, get a move-by reminder, and get help fast if your car is towed

TICKETS

- Add your plate and see every NYC parking and camera ticket in one place, on a map
- Get alerted when a new ticket shows up
- Know exactly when late fees start, before a ticket goes into judgment
- Boot and tow risk warnings
- Fight a ticket with an AI-written dispute letter

PLANS

Rova is free, with ads only on screens you see while stopped. Upgrade for more:

- Bronze, $4.99/mo: no ads, AI voices, AI parking-sign reading
- Silver, $8.99/mo: early penalty warnings, 2 AI disputes a month
- Gold, $14.99/mo: up to 3 plates, unlimited disputes, truck mode
- Fleet, $12 per car/mo: Gold for every car you run, 3-car minimum

Subscriptions renew monthly until cancelled. Cancel anytime in your account settings.

Always follow posted signs and traffic laws. Routes, parking colors and ticket dates are guidance only. Ticket data comes from NYC Open Data.

Terms: https://player-check.onrender.com/terms
Privacy: https://player-check.onrender.com/privacy

## Google Play

The full description is the same as Apple's above; paste it as is. Google has no keyword field, so the short description carries the search words.

| Field | Text | Limit |
|---|---|---|
| App name | Rova: GPS & Ticket Alerts | 30 (25 used) |
| Short description | Free GPS with camera alerts, NYC ticket alerts and AI disputes. Park legal. | 80 (75 used) |
| Full description | Same as the Apple description | 4,000 |
| Feature graphic | 1024 × 500, Rova logo on the dark navy background with the subtitle | required |
| Contains ads | Yes | |
| In-app purchases | Yes (subscriptions) | |

## Screenshots

Six shots, in this order; the first two do most of the selling. Take them on your iPhone using the demo plate ROVADEMO, so no real person's tickets appear.

| # | Caption on the image | What to show |
|---|---|---|
| 1 | Know before the late fee hits | Ticket list for ROVADEMO: the $65 ticket with "late fee starts" and the camera ticket in penalty |
| 2 | Fight tickets with AI | A finished AI dispute letter on screen |
| 3 | Free GPS with camera alerts | Route preview in Brooklyn with camera icons on the route |
| 4 | Know if you can park here | Park tab: the green "Can I park here?" answer for a block |
| 5 | Never lose your car | Parked-car screen with the move-by time |
| 6 | Plans from $4.99 | The Rova plans screen |

Sizes: Apple needs 6.9-inch iPhone shots (1320 × 2868); Google takes any phone shots between 320 and 3840 pixels. Captions go on top of each image; I can lay them out once you send the raw screenshots.

## App review: demo login

The reviewer signs in with a demo account that gets Gold free, and adds the sample plate ROVADEMO to see tickets. Both are already built.

- ☐ Create the demo account in Rova: email **getrovaapp+review@gmail.com** (Gmail delivers +review mail to your normal inbox), pick a password and save it in your notes, not in this doc if you share it
- ☐ Sign in and add plate **ROVADEMO**, state NY, so it's already loaded when the reviewer signs in

| Field | Value |
|---|---|
| Sign-in required | Yes |
| Username | getrovaapp+review@gmail.com |
| Password | the one you choose above |
| Plan on that account | Gold, free (set on Render as COMP_GOLD) |
| Sample plate | ROVADEMO, NY: 4 sample tickets, not a real person's |

### Notes for the reviewer (paste as is)

Rova is GPS navigation plus NYC parking-ticket alerts. Sign in with the demo account above; it has the Gold plan and the sample plate ROVADEMO already saved. Tap the plate pill on the map to see the sample tickets, then tap "Dispute this ticket" to see an AI-written dispute letter. Ticket data comes from NYC's public Open Data; ROVADEMO returns sample tickets so no real person's data is shown. Location is used only while the app is open, for directions and nearby alerts. Ads appear only on free accounts and only on screens used while stopped, never during navigation. Accounts can be deleted in the app under the account screen, Delete account.

## Privacy answers

Both stores ask what data Rova collects. These answers match the privacy policy; none of it is sold, and the only tracking is AdMob's ads on free accounts.

| Data | Collected | Linked to the account | Used for |
|---|---|---|---|
| Email address | Yes | Yes | Account, ticket alert emails |
| Precise location | Yes, only while the app is open | No | Directions, nearby alerts, parking rules, local ads |
| License plates and vehicle details | Yes | Yes | Ticket checks, truck routing |
| Saved places, parked car, settings | Yes | Yes | Syncing across phones |
| Purchase history | Yes | Yes | Subscriptions (cards handled by Stripe, Apple or Google) |
| Device ID for ads | Yes, free plan only | No | AdMob advertising |
| Crash and error reports | Yes | No | Fixing bugs |
| Text typed for AI disputes | Yes | Yes | Drafting the letter |

- Data encrypted in transit: Yes
- Users can delete their data: Yes, in the app (Delete account)
- Data sold to third parties: No
- Apple tracking prompt: shown before ads on iPhone, since AdMob uses the ad ID

## Submission checklist

Everything free is done or ready; what's left mostly waits on the paid accounts. Goal: both stores before January 1, 2027.

**Free, do anytime**

- ☐ Create the demo account and add ROVADEMO (App review section)
- ☐ Take the 6 screenshots with ROVADEMO
- ☐ Make the 1024 × 500 Google feature graphic
- ☐ Send a sharper 1024px app icon if you have one

**Paid, when ready to submit**

- ☐ Google Play developer account, $25 once: create the listing, upload the Android build from Codemagic (needs a signed release build, which I'll set up)
- ☐ Apple developer account, $99/yr: create the app in App Store Connect, add the Codemagic key, then I switch on iPhone notifications, iPhone ads and in-app purchases
- ☐ Form the LLC, then add AdMob payment details and swap the LLC name into the terms
- ☐ Lawyer review of terms and privacy
- ☐ Google voice key ($0 with a credit card)
- ☐ Render Starter, $7/mo, right before launch

**Launch day switches (I do these)**

- ☐ Stripe live mode: copy the four plans to the live account and swap the checkout links
- ☐ ADMOB_LIVE=1 on Render so store ads are real
- ☐ Plans available as in-app purchases in both stores, as Apple requires for iPhone purchases
