# Design your tutut

The island shows the character from this folder.

## Swap in your own character
Drop **one** file here named `tutut` with any of these extensions:

| File | Notes |
|---|---|
| `tutut.png` / `tutut.webp` | Best. Transparent background, at least 256×256 |
| `tutut.gif` | Animated GIFs play as-is |
| `tutut.svg` | Inlined, so the part animations below work if you use the same ids |
| `tutut.jpg` | Works, shown with rounded corners (no transparency) |

`tutut.*` always wins over `default.svg` (the trial mint bunny-bean). Delete your file to get the trial one back.
Restart the host (restart Chrome, or `pkill -f native-host/host.py`), or run `./native-host/host.py --demo` to preview.

## Optional: one image per mood
Add any of these next to `tutut.png` and the island switches to them:

| File | When |
|---|---|
| `tutut-alert.png` | Claude asks for permission |
| `tutut-waiting.png` | A chat needs your input |
| `tutut-yes.png` | You clicked Allow / Open chat |
| `tutut-no.png` | You clicked Deny / Dismiss |

## Animations
`character.css` holds every animation, so edit it freely. The stage gets one class: `.alert`, `.waiting`, `.yes` or `.no`.

- **Image characters:** the whole image moves (bounce, bob, hop, shake).
- **SVG characters:** parts can move too if they use these ids or classes:
  - `#ear-left` / `#ear-right` with class `ear`: perk, twitch and droop
  - `.eye`: blinks
  - `#body`, `#mouth`: free for your own animations
