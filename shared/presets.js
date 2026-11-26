// Video types. Each one gives the assistant genre-specific editing guidance
// and the UI a set of one-click requests. A project picks one in the
// assistant panel (project.settings.videoType); "general" is the default.
//
// To add a type: add an entry here. No other code changes are needed.

export const VIDEO_TYPES = {
  general: {
    label: "General",
    guidance: `This is a general video with no particular genre. Ask yourself what the viewer cares about and cut toward that: remove dead air and false starts, keep the pacing tight, and use effects sparingly to emphasize genuinely important moments rather than decorating everything.`,
    chips: [
      ["Cut dead air", "Remove the silent pauses and slow parts. Keep natural breathing room around speech."],
      ["Highlight reel", "Make a highlight reel under 60 seconds from the most interesting moments."],
      ["Vertical Short", "Make a vertical 9:16 version under 60 seconds for Shorts, Reels or TikTok."],
      ["Add a title", "Add an opening title card for the first 3 seconds."],
      ["Chapter markers", "Add chapter markers at the main topic or scene changes."],
      ["Describe my footage", "Describe what's in my footage and suggest how to edit it. Don't change anything yet."],
    ],
  },

  unboxing: {
    label: "Unboxing / pack opening",
    guidance: `This is an unboxing or pack-opening video (trading cards, collectibles, mystery boxes, products).
- These follow a rhythm: intro, opening, then items revealed one at a time, with the best ones (for card packs, the rare "hit" cards) often near the end. The creator's reaction (louder voice, "let's go!", "no way!") usually follows a great reveal, so loud moments are strong clues. Confirm with the keyframes: look for a shiny, full-art, holographic or otherwise special item being held up.
- A good hype treatment for a big reveal, timed to the moment it's shown: a tension riser or drumroll starting ~1.5-2s before; at the reveal a short flash (0.2-0.4s) plus a sparkle or ka-ching sound; a zoom punch-in (1.5-3s); then optionally a 1-1.5s freeze frame or ~0.5x slow motion. Add an "impact" title only if you can actually read the item's name or the user told you what it is. Never guess names.
- Use rainbow for holographic or shiny items, shake plus boom or air horn only for the single biggest moment, and keep ordinary reveals clean. Treat the best 1-4 moments.`,
    chips: [
      ["✨ Hype my best reveals", "Find the best reveals and hype them up: build-up sound before each one, flash and sparkle at the reveal, zoom in on the item, and a freeze frame or slow motion on the biggest one. Keep ordinary reveals clean."],
      ["Find my best moments", "Which moments look like my best reveals or pulls? List them with timestamps and what you can see. Don't change anything yet."],
      ["Cut dead air", "Remove the silent pauses and slow parts between reveals. Keep natural breathing room around speech."],
      ["60s Short", "Make a vertical 9:16 Short under 60 seconds: a quick intro, then the best reveals with effects."],
      ["Chapter markers", "Add chapter markers at each new box or pack and each big reveal."],
    ],
  },

  gaming: {
    label: "Gaming",
    guidance: `This is gaming footage (gameplay, streams, clips).
- The best moments are clutch plays, wins, kills, funny fails and big reactions. Loud moments often mark them (voice reactions or in-game explosions); confirm with the keyframes (kill feeds, victory screens, health bars, big on-screen action).
- Cut menus, loading screens, long walking or waiting, and dead air.
- For a highlight: shake plus boom on impacts, flash on kills or wins, slow motion (0.4-0.6x) on the clutch moment, a freeze frame with an impact title for a funny fail. Keep each effect short so gameplay stays readable.`,
    chips: [
      ["Highlight montage", "Make a highlight montage of my best plays and reactions, with punchy effects on the biggest moments."],
      ["Cut the downtime", "Remove loading screens, menus, waiting and dead air. Keep the action."],
      ["Clip for Shorts", "Find my single best moment and turn it into a vertical 9:16 clip under 30 seconds with effects."],
      ["Find funny moments", "List the moments that look funniest or most chaotic, with timestamps. Don't change anything yet."],
      ["Chapter markers", "Add chapter markers for each round, match or major event."],
    ],
  },

  vlog: {
    label: "Vlog / talking head",
    guidance: `This is a vlog or talking-head video.
- Jump cuts are normal: remove pauses, ums and false starts tightly, keeping ~0.1s of breathing room.
- Keep the speaker engaging with occasional subtle zoom punch-ins (intensity ~0.12-0.2) on key sentences, alternating zoomed and not so cuts feel fresh. Don't zoom constantly.
- Use captions or titles to emphasize key points if there's a transcript. Big effects and loud sounds are usually wrong here; a pop or whoosh on a topic change is plenty.
- Captions: one add_text per short phrase (3-8 words, "caption" look, bottom), timed to the timeline transcript, with no overlaps.
- Without a transcript you can only see pauses, loudness and frames, not what's being said. For anything that depends on the words, say so and suggest clicking "📝 Transcribe" on the video in the media pool.`,
    chips: [
      ["Tighten jump cuts", "Remove pauses, ums and false starts with tight jump cuts. Keep it natural."],
      ["Add captions", "Add captions for everything I say, in short readable phrases at the bottom of the screen."],
      ["Subtle punch-ins", "Add subtle zoom punch-ins on key moments to keep it engaging. Don't overdo it."],
      ["Vertical Short", "Make a vertical 9:16 Short under 60 seconds from the strongest part."],
      ["Key-point titles", "Add short titles for the main points I make."],
      ["Chapter markers", "Add chapter markers at each topic change."],
    ],
  },

  tutorial: {
    label: "Tutorial / screen recording",
    guidance: `This is a tutorial, course or screen recording.
- Clarity beats hype. Remove dead air, mistakes and long waits (loading, typing pauses), but keep every step the viewer needs.
- Zoom (intensity ~0.2-0.35) only to make small on-screen detail readable. Note that zoom is centered on the frame, so say so if the important area is near an edge.
- Add a title for each step and chapter markers for each section. Avoid flashy effects and loud sounds.`,
    chips: [
      ["Clean it up", "Remove dead air, mistakes and long waits, keeping every step."],
      ["Step titles", "Add a short title at the start of each step."],
      ["Chapter markers", "Add chapter markers for each section."],
      ["Summary clip", "Make a 60-second overview clip showing the key steps."],
    ],
  },

  sports: {
    label: "Sports / action",
    guidance: `This is sports or action footage.
- The best moments are goals, big hits, tricks, saves and finishes; crowd or commentator noise (loud moments) often marks them. Confirm with the keyframes.
- Classic treatment: build-up riser, then at the key moment a flash and boom, slow motion replay (0.4-0.5x), and a freeze frame with an impact title for the very best one. Keep the lead-up so the viewer understands the play.`,
    chips: [
      ["Highlight reel", "Make a highlight reel of the best plays with slow-motion replays on the top moments."],
      ["Slow-mo the best moment", "Find the single best moment and give it a slow-motion replay with a flash and boom."],
      ["Vertical Short", "Make a vertical 9:16 Short under 60 seconds of the top plays."],
      ["Find the key plays", "List the key plays with timestamps. Don't change anything yet."],
    ],
  },
};

export const DEFAULT_VIDEO_TYPE = "general";

export function videoTypeOf(project) {
  const t = project?.settings?.videoType;
  return VIDEO_TYPES[t] ? t : DEFAULT_VIDEO_TYPE;
}
