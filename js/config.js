/* Agent Island — world configuration */
window.ISLE = {
  name: "Dawnbreak",
  code: "ISLE-01",
  tagline: "A little island. Lives of their own.",
  radius: 40,

  places: [
    { id: "palm-court",   name: "Bryan's place",           x: -14, z: -10, color: 0x7ddf9a },
    { id: "tidework",     name: "Michelle's place",        x:  12, z: -14, color: 0x7cc7ff },
    { id: "market",       name: "bozo's place",            x:   2, z:   4, color: 0xffc46b },
    { id: "garden",       name: "gitlawb corner",          x: -18, z: 12, color: 0xa8e06b },
    { id: "cafe",         name: "Grom's place",            x:  16, z:  10, color: 0xff9d6b },
    { id: "kitchen",      name: "Duhleet's Soup Kitchen", x: -4, z: -22, color: 0xff8f8f },
    { id: "workshop",     name: "Delphine Roux's place",   x:  20, z:  -2,  color: 0xc9a7ff },
    { id: "dock",         name: "Silas Marchetti's place", x:   0, z:  26, color: 0x8fd8ff },
    { id: "ezra",         name: "Ezra Whitlock's place",   x:  -8, z:  20, color: 0x4cc9f0 },
  ],

  roster: [
    { name: "Pip",            color: 0xe8c98a, personality: "cheerful tinkerer who loves shiny things" },
    { name: "Mushoh",         color: 0xb9a7e6, personality: "soft-spoken dreamer who hums while wandering" },
    { name: "Bryan",          color: 0x8fbf7f, personality: "methodical builder, keeper of the workshop" },
    { name: "Fern",           color: 0x7da05a, personality: "gentle gardener who talks to plants" },
    { name: "Miso",           color: 0xf0e0c0, personality: "cozy soup enthusiast and warm friend" },
    { name: "Michelle",       color: 0xd64545, personality: "fiery host of the café plaza" },
    { name: "Duhleet",        color: 0xe8935a, personality: "soup kitchen chef, feeds everyone who visits" },
    { name: "Otto",           color: 0xb08954, personality: "brisk engineer, speaks in checklists" },
    { name: "Grom",           color: 0x6b5d4f, personality: "gruff but loyal night watch" },
    { name: "bozo",           color: 0x4fb3a9, personality: "playful trickster of the market corner" },
    { name: "Delphine Roux",  color: 0xe88bb0, personality: "dreamy artist painting the sky" },
    { name: "Silas Marchetti",color: 0x5b7a99, personality: "quiet cartographer mapping every path" },
    { name: "Ezra Whitlock",  color: 0x6fb7e8, personality: "storyteller collecting island tales" },
    { name: "ROKKO BASILISK", color: 0x2e2a33, personality: "mysterious drifter with a spiky crest" },
  ],

  happenings: [
    "The Open Workshop",
    "Lantern Lighting at Grom's place",
    "Night Market at Silas Marchetti's place",
    "Moth Trail Expedition",
    "Story Circle at gitlawb corner",
  ],

  storyTemplates: [
    "{a} followed a trail of glowing moths and returned with star sand",
    "{a} and {b} built a tiny bridge over the stream at {p}",
    "{a} brewed moonberry tea for everyone at {p}",
    "{a} found a message in a bottle near {p}: \"the tide remembers\"",
    "{b} taught {a} the old lantern song at {p}",
    "{a} mapped a new shortcut between {p} and the shore",
    "{a} left a sketch of the sunrise pinned at {p}",
    "{b} and {a} raced paper boats from {p} at dusk",
    "{a} repaired the wind chimes at {p}; the island hums again",
    "{a} planted starlight seeds in {p} — they sprouted overnight",
  ],

  chatFallbacks: [
    "Hmm, let me think about that while I walk...",
    "The tide brought something interesting today — ask me about the island!",
    "I was just heading to {p}. Walk with me?",
    "That's a good question for Ezra, our storyteller. But here's what I think...",
    "*adjusts lantern* The island feels alive today, doesn't it?",
  ],
};
