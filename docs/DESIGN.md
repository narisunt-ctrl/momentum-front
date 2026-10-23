# Momentum Front — Design Notes

## Core idea
"A tank that stops is a tank that dies." Every tank always moves: the lowest forward gear still runs at ~24 km/h and there is no brake. The player's real choices are gear (speed), hull direction, and when to change them. That turns movement into the main defensive skill.

## The loop that makes it fun
1. The enemy's fire-control AI watches you through its sensors.
2. If you drive straight at a steady speed, its Kalman filter predicts you perfectly and its Pk climbs. You see a **LOCK WARNING**.
3. Jink: change gear, swerve, break line of sight behind a hill or smoke. The tracker's manoeuvre index rises, its prediction spread grows, Pk falls.
4. Meanwhile your own FCS is doing the same to them. You decide when Pk is high enough to commit a 2.6 s reload.

Because hits depend on armour angle, flanking the side (70 mm) or rear (40 mm) matters more than raw accuracy; a frontal shot can ricochet.

## Pressure
- Artillery barrage outside a shrinking, drifting circle (radius 215 m → 32 m from 25 s onward).
- Supply drops by parachute pull players into the open: repair, smoke, radar uplink (see everyone, track through smoke for 15 s).
- 4-minute round limit; ties go to the team with the most hull points left.

## Realism choices (scaled for play)
| Quantity | Value | Note |
|---|---|---|
| AP muzzle velocity | 165 m/s | scaled down from ~1,600 so lead and drop are visible |
| HE muzzle velocity | 98 m/s | higher arc, 7.5 m splash, can break tracks |
| Drag | quadratic, air-relative | wind 0.5–8 m/s drifts over time |
| Turret traverse / elevation | 45 °/s / 12.6 °/s | elevation −8° to +20° |
| Gun dispersion | 1.4 mrad, +1.1 mrad at full speed | firing on the move is less accurate |
| Armour | front 120, side 70, rear 40, turret 120–140, top 25 mm | effective = t / cos θ; ricochet above 70° |

## Bots
Utility-style behaviour: choose a target by distance, visibility and weakness; orbit at a preferred range; weave; avoid buildings with ray probes; reverse when stuck; seek crates when hurt; pop smoke when locked and damaged. Gunnery uses the same FCS as players, with skill-dependent lay error, acquisition delay and Pk threshold.

## Possible next steps
- Online multiplayer (WebRTC/WebSocket server, host-authoritative).
- Train the bot driving policy with reinforcement learning against the scripted bots.
- Map editor and more vehicle classes (fast light tank, slow heavy tank).
