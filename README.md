# Plate Check

NYC driving app: plate ticket lookup, tickets pinned on a map, speed and red light cameras, and turn-by-turn navigation with camera warnings.

Live at https://player-check.onrender.com

## Drive features (Waze / Google Maps parity)
- Road-ahead warnings: speed-limit drops, sharp curves, speed bumps, railroad crossings, toll booths, school zones (weekday school hours)
- Add a stop along the route: gas, coffee, food, EV charging, parking (before or during a drive)
- Share your drive: live ETA link at `/t/<id>` that updates every ~10s and ends on arrival
- Auto night map during drives after sunset (when the default map is selected)
- "Fewer voice prompts" mode
- Pay for parking: ParkNYC (city's official app/web) button on metered spots + meter timer with reminder before it runs out
- Hands-free voice commands while driving: report (police, accident, closed road…), add a gas/coffee/food/EV/parking stop, share my drive, "when will I arrive", "where can I park there"
- Weather on your route (Open-Meteo): rain, snow, storms, fog at the time you'll be there, spoken heads-up
- Parking at your destination shown on the route screen before you leave
- My car hub: "My car is gone" tow help (NYC towed-vehicle finder, precinct, fees, what to bring) and registration / inspection / insurance renewal reminders (in-app at 30 and 7 days, plus calendar reminder)
- Pay-before-penalty: each open ticket shows its pay-by date, a Pay now link (CityPay) and a calendar reminder 2 days before the late fee
- Rovers (customizable: 9 colors, 6 faces, 6 hats; Gold, Midnight, Crown, Halo tagged Premium): other Rova drivers shown live on the map (like Waze's Wazers). Real drivers only, anonymous, rounded to ~10 m, shown only while moving, removed 2 min after they stop; never stored. Toggles in the map layers panel: "Rovers" (see others) and "Show me as a Rover" (share yourself)
- Truck mode: routes kept on NYC DOT's official Truck Route Network (data: NYC Open Data jjja-shxy + Borough Boundaries gthc-hcne). Through routes when crossing a borough with no stop, Local routes for stops; every 20 m of the final route is checked against the official network and any off-network stretch or parkway is flagged. Truck profile (van / box / straight / tractor-trailer, height, weight, length, hazmat), low-clearance and weight-limit warnings from OpenStreetMap, truck network map overlay (Through orange, Local green, Limited Local purple). Status: /api/truck/status
- Hazmat in truck mode: avoids Holland, Lincoln, Queens-Midtown and Hugh L. Carey tunnels and the GWB lower level (explosives: also Verrazzano); when the direct way into NYC uses a banned crossing, re-routes through an FDNY-designated entry (GWB upper, Goethals, Bayonne, Outerbridge, Throgs Neck). Official MTA clearances: Queens-Midtown and Hugh L. Carey tunnels 12'1" are avoided for taller trucks. Shows FDNY through-transit hours and permit reminder.
- Nationwide truck routing: set Render env `TOMTOM_KEY` (TomTom developer key) to route trucks anywhere in the US with height, weight, length, axles, US hazmat class 1–9 and live traffic; NYC routes are still checked against the official NYC truck network. Without the key, truck mode uses the free route engine + NYC check.
- Route server backup: if the public OSRM server doesn't answer, routes come from routing.openstreetmap.de (car and truck).

_Deploys: Render auto-deploys `main` on every commit._
