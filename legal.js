// Terms of Service (/terms) and Privacy Policy (/privacy).
// Before launch: put the LLC's legal name in COMPANY, and have a lawyer review both pages.

const COMPANY = "Rova";                 // e.g. "Rova Technologies LLC" once the LLC is formed
const CONTACT = "getrovaapp@gmail.com";
const UPDATED = "October 21, 2026";
const STATE = "New York";

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Rova</title>
<style>
:root{color-scheme:dark;--bg:#01050e;--ink:#e8eaed;--muted:#9aa0a6;--blue:#8ab4f8;--line:#2a2f3a}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:720px;margin:0 auto;padding:28px 16px 64px}
a{color:var(--blue)}h1{font-size:30px;line-height:1.2;margin:8px 0 4px}h2{font-size:19px;margin:30px 0 6px}
.muted{color:var(--muted);font-size:14px}.box{border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin:18px 0;background:#0b1220}
ul{padding-left:20px}li{margin:4px 0}.top{display:flex;gap:14px;font-size:14px}
</style></head><body><main>
<div class="top"><a href="/">← Back to Rova</a><a href="/terms">Terms</a><a href="/privacy">Privacy</a></div>
<h1>${title}</h1><p class="muted">Last updated ${UPDATED}</p>
${body}
<h2>Contact</h2><p>${COMPANY} · <a href="mailto:${CONTACT}">${CONTACT}</a></p>
</main></body></html>`;

const TERMS = page("Terms of Service", `
<p>These terms are an agreement between you and ${COMPANY} ("Rova", "we", "us") for using the Rova app and website (the "Service"). By using Rova you agree to them. If you don't agree, don't use Rova.</p>

<div class="box"><b>The short version:</b> Rova is a helper, not a guarantee. Always obey traffic laws, posted signs and police. Routes, truck routes, parking colors, camera alerts and ticket information can be wrong or out of date. AI dispute letters are not legal advice.</div>

<h2>1. Who can use Rova</h2>
<p>You must be at least 18 years old (or the age of majority where you live) to create an account or buy a plan. You're responsible for your account and for keeping your password private.</p>

<h2>2. Driving safely comes first</h2>
<ul>
<li>Don't type, read or look at Rova while your vehicle is moving. Set your route before you drive and use voice guidance. Where possible, have a passenger operate the app.</li>
<li>Follow all traffic laws, posted signs, signals, road markings and directions from police and traffic officers, even when Rova says something different.</li>
<li>You alone decide how to drive, where to go and where to park. You are responsible for your vehicle, your driving and any tickets, fines, tows or damage.</li>
</ul>

<h2>3. Navigation and routes are guidance only</h2>
<p>Routes, turn-by-turn directions, travel times, traffic, weather and road reports come from public and third-party map data and from other drivers. They may be incomplete, delayed or wrong. Roads close, rules change and conditions vary. Rova may route you onto a road that is closed, unsafe, restricted or unsuitable for your vehicle. Use your own judgment at all times.</p>

<h2>4. Truck mode</h2>
<p>Truck mode tries to follow official truck routes and your vehicle's height, weight and hazmat details, but it cannot check every bridge, overpass, tunnel, parkway, weight limit, hazmat restriction or local rule, and it may not cover every area. <b>You must confirm that every road is legal and safe for your vehicle and follow all posted truck, height, weight and hazmat signs.</b> You are responsible for your vehicle's height, weight, load and permits and for entering your vehicle details correctly.</p>

<h2>5. Parking information</h2>
<p>Curb colors, "can I park here" answers, sign readings, meter info, street cleaning and "move by" times are estimates based on city data and photos. Signs on the street always control. Rova is not responsible for parking tickets, tows or boots, even if the app showed a spot as legal.</p>

<h2>6. Ticket alerts, penalty and boot warnings</h2>
<p>Ticket information comes from New York City's public Open Data records. It may be delayed, incomplete or wrong, and new tickets may take days to appear. Judgment dates, late-fee dates and boot or tow risk are estimates, not official notices. Always confirm with the NYC Department of Finance or the issuing agency. Rova does not pay or contest tickets for you.</p>

<h2>7. AI dispute letters are not legal advice</h2>
<p>Rova can draft a ticket dispute letter using AI. Rova is not a law firm, and the letters are not legal advice. We don't guarantee any result, and a ticket may not be reduced or dismissed. Review every letter, make sure it's true and accurate, and submit it yourself. Only include evidence and statements you know are true. For legal advice, talk to a lawyer.</p>

<h2>8. Speed and red-light camera alerts</h2>
<p>Camera alerts are for awareness only and may miss cameras or show ones that have moved. They are not an invitation to speed anywhere. Always drive at or below the posted limit. Using camera alerts may not be allowed in every place; you're responsible for following local law.</p>

<h2>9. Things you share</h2>
<p>When you post a road report or other content, you confirm it's accurate as far as you know and you give Rova permission to show it to other drivers. Don't post anything false, harmful or illegal, or anything that identifies another person. We may remove content and suspend accounts that break these terms.</p>

<h2>10. Plans, payments and cancelling</h2>
<ul>
<li>Rova has a free plan and paid plans (Bronze, Silver, Gold and Fleet). Prices and features are shown before you buy and may change. We'll tell you before a price change affects you.</li>
<li><b>Paid plans renew automatically every month</b> until you cancel. You can cancel anytime in the app under <i>Manage plan</i>. Your plan stays active until the end of the period you paid for.</li>
<li>Website payments are processed by Stripe. Purchases made through the Apple App Store or Google Play are billed by Apple or Google and follow their payment, cancellation and refund rules.</li>
<li>Except where the law requires otherwise, payments are non-refundable, including for partly used months. If something went wrong, email us and we'll look at it.</li>
<li>Fleet plans are billed per vehicle with a 3-vehicle minimum. The fleet owner is responsible for every driver on the account.</li>
</ul>

<h2>11. Ads</h2>
<p>The free plan may show ads, including offers from local businesses, only on screens used while stopped. We don't endorse advertisers, and your dealings with them are between you and them.</p>

<h2>12. Acceptable use</h2>
<p>Don't misuse Rova: no hacking, scraping, overloading our servers, reselling the Service, tracking other people, or using Rova to break the law.</p>

<h2>13. Third-party services and data</h2>
<p>Rova uses maps, routing, city data, weather and other services from third parties. We don't control them and aren't responsible for their accuracy or availability. Map data © OpenStreetMap contributors.</p>

<h2>14. No warranty</h2>
<p>ROVA IS PROVIDED "AS IS" AND "AS AVAILABLE," WITHOUT WARRANTIES OF ANY KIND, WHETHER EXPRESS OR IMPLIED, INCLUDING ACCURACY, RELIABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NON-INFRINGEMENT. We don't promise the Service will be uninterrupted, error-free or always available.</p>

<h2>15. Limit of liability</h2>
<p>TO THE FULLEST EXTENT ALLOWED BY LAW, ${COMPANY.toUpperCase()} WILL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL OR PUNITIVE DAMAGES, OR FOR ANY TICKETS, FINES, TOWS, BOOTS, VEHICLE DAMAGE, ACCIDENTS, INJURIES, DELAYS OR LOST PROFITS ARISING FROM YOUR USE OF ROVA OR RELIANCE ON ITS ROUTES, ALERTS, PARKING INFORMATION OR DISPUTE LETTERS. OUR TOTAL LIABILITY FOR ANY CLAIM IS LIMITED TO THE GREATER OF THE AMOUNT YOU PAID US IN THE 12 MONTHS BEFORE THE CLAIM OR US$100. Some places don't allow some of these limits, so they may not all apply to you.</p>

<h2>16. Indemnity</h2>
<p>You agree to cover ${COMPANY}'s losses and costs (including reasonable legal fees) from claims arising out of your driving, your vehicle, your content, or your breaking these terms or the law.</p>

<h2>17. Ending your account</h2>
<p>You can stop using Rova and delete your account at any time. We may suspend or close accounts that break these terms. Sections that by their nature should continue (like 14 to 18) survive.</p>

<h2>18. Law and disputes</h2>
<p>These terms are governed by the laws of the State of ${STATE}, without regard to conflict-of-law rules. Disputes will be handled in the state or federal courts located in ${STATE}, and you and we agree to their jurisdiction, except that either of us may bring a claim in small claims court.</p>

<h2>19. Changes</h2>
<p>We may update these terms. If changes are significant, we'll tell you in the app or by email before they take effect. Using Rova after that means you accept the new terms.</p>
`);

const PRIVACY = page("Privacy Policy", `
<p>This policy explains what ${COMPANY} ("Rova", "we") collects when you use the Rova app and website, how we use it, and your choices.</p>

<div class="box"><b>The short version:</b> We use your location to guide you and show what's around you. We use your plate to check its tickets. <b>We don't sell your personal information.</b> Other drivers never see your name or plate.</div>

<h2>What we collect</h2>
<ul>
<li><b>Account:</b> your email and a scrambled (hashed) version of your password. We never see or store your actual password.</li>
<li><b>Plates and vehicle:</b> license plates you save, your vehicle type, and truck details if you use truck mode.</li>
<li><b>Location:</b> your device's location while you use the app, for directions, nearby results, parking rules, alerts and showing your position. Rova does not track your location in the background when the app is closed.</li>
<li><b>Saved places and settings:</b> home, work, recent searches, your parked car's spot and time, renewal dates, alert settings and your Rover look. These sync to your account so they work on any phone you sign in on.</li>
<li><b>Ticket information:</b> tickets for your saved plates from New York City's public Open Data records.</li>
<li><b>Dispute details:</b> what you type into a dispute request, used to draft your letter.</li>
<li><b>Road reports:</b> the type, place and time of reports you post. Reports aren't linked to your name.</li>
<li><b>Payments:</b> handled by Stripe, Apple or Google. We receive your plan, payment status and a customer ID. We never receive or store your full card number.</li>
<li><b>Technical info:</b> app error reports, IP address (for security and rate limits), and basic device and browser details.</li>
<li><b>Advertising inquiries:</b> if a business asks to advertise, the name and contact details it sends us.</li>
</ul>

<h2>How we use it</h2>
<ul>
<li>To run Rova: routes, voice guidance, camera and road alerts, parking checks, ticket checks and alerts, dispute letters, and syncing your account.</li>
<li>To send emails you asked for, like ticket alerts.</li>
<li>To process payments and manage your plan.</li>
<li>To show ads on the free plan, including nearby local offers based on your approximate location.</li>
<li>To keep Rova safe, prevent abuse, fix bugs and improve the app.</li>
<li>To follow the law.</li>
</ul>

<h2>Rovers (other drivers on the map)</h2>
<p>While you're moving, Rova may show your car to other nearby Rova drivers as an anonymous icon. It uses a random ID with no name, email or plate, your position rounded to about 10 meters, and it disappears 2 minutes after your last update. This information is not stored.</p>

<h2>Shared trips</h2>
<p>If you share your trip, anyone with the link can see your live position and arrival time until the trip ends. Shared trips expire automatically after 3 hours.</p>

<h2>Who we share it with</h2>
<p>We don't sell or rent your personal information. We share it only with service providers that help run Rova, only as needed to provide their service:</p>
<ul>
<li>Hosting and database: Render, Supabase</li>
<li>Payments: Stripe, and Apple or Google for in-app purchases</li>
<li>AI dispute drafting: Anthropic (the details of the ticket and the text you enter)</li>
<li>Voice: Google Cloud Text-to-Speech (only the words to be spoken, for paid-plan voices)</li>
<li>Email delivery: Google (Gmail)</li>
<li>Maps, search, routing, traffic and weather: OpenFreeMap, OpenStreetMap-based services, TomTom, NYC GeoSearch and Open-Meteo, which receive the places and coordinates needed to answer your request</li>
<li>Ads (store apps): Google AdMob may receive device identifiers and approximate location to show ads to free-plan users</li>
</ul>
<p>We may also share information if the law requires it, to protect someone's safety, or as part of a sale or merger of the business (with notice to you).</p>

<h2>How long we keep it</h2>
<p>We keep your account information until you delete your account. Rover positions are kept for 2 minutes, shared trips for 3 hours, and road reports until they expire. Payment records are kept as long as tax and accounting laws require.</p>

<h2>Your choices and rights</h2>
<ul>
<li>Turn location off in your phone's settings at any time. Some features won't work without it.</li>
<li>Remove plates, places and settings in the app.</li>
<li>Ask to see, correct or delete your information, or delete your account, by emailing <a href="mailto:${CONTACT}">${CONTACT}</a>. We'll respond within 30 days.</li>
<li>Upgrade to a paid plan to remove ads.</li>
<li>Depending on your state (for example, California), you may have more rights, such as knowing what we collect and opting out of "sale" or "sharing." We don't sell personal information. To use any of these rights, email us.</li>
</ul>

<h2>Security</h2>
<p>We protect your information with encryption in transit, hashed passwords and restricted database access. No system is perfectly secure, so please use a strong password you don't use anywhere else.</p>

<h2>Children</h2>
<p>Rova is not meant for children under 13, and we don't knowingly collect their information. If you think a child has given us information, email us and we'll delete it.</p>

<h2>Changes</h2>
<p>We may update this policy. If changes are significant, we'll tell you in the app or by email first.</p>
`);

function routes(url, res, send) {
  if (url.pathname === "/terms") { send(res, 200, TERMS, "text/html; charset=utf-8", "public, max-age=3600"); return true; }
  if (url.pathname === "/privacy") { send(res, 200, PRIVACY, "text/html; charset=utf-8", "public, max-age=3600"); return true; }
  return false;
}

module.exports = { routes };
