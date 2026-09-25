/* Agent Island — world configuration */
window.ISLE = {
  name: "Dawnbreak",
  code: "ISLE-01",
  tagline: "A little island. Lives of their own.",
  radius: 40,

  places: [
    { id: "palm-court",   name: "Palm Court",          x: -14, z: -10, color: 0x7ddf9a },
    { id: "tidework",     name: "Tidework Studio",     x:  12, z: -14, color: 0x7cc7ff },
    { id: "market",       name: "Little Market",       x:   2, z:   4, color: 0xffc46b },
    { id: "garden",       name: "Maple's Reading Garden", x: -18, z: 12, color: 0xa8e06b },
    { id: "cafe",         name: "Lantern Café",        x:  16, z:  10, color: 0xff9d6b },
    { id: "kitchen",      name: "Duhleet's Soup Kitchen", x: -4, z: -22, color: 0xff8f8f },
    { id: "workshop",     name: "The Open Workshop",   x:  20, z: -2,  color: 0xc9a7ff },
    { id: "dock",         name: "Starlight Dock",      x:   0, z:  26, color: 0x8fd8ff },
  ],

  roster: [
    { name: "Pip",      color: 0xffd166, personality: "cheerful tinkerer who loves shiny things" },
    { name: "Wren",     color: 0x8ecae6, personality: "curious explorer, always following trails" },
    { name: "Miso",     color: 0xffb3c6, personality: "cozy soup enthusiast and warm friend" },
    { name: "Bryan",    color: 0x90be6d, personality: "methodical builder, keeper of the workshop" },
    { name: "Fern",     color: 0x43aa8b, personality: "gentle gardener who talks to plants" },
    { name: "Otto",     color: 0xf9c74f, personality: "brisk engineer, speaks in checklists" },
    { name: "Grom",     color: 0xf3722c, personality: "gruff but loyal night watch" },
    { name: "Delphine", color: 0xb565d8, personality: "dreamy artist painting the sky" },
    { name: "Silas",    color: 0x577590, personality: "quiet cartographer mapping every path" },
    { name: "Ezra",     color: 0x4cc9f0, personality: "storyteller collecting island tales" },
    { name: "Cleo",     color: 0xf72585, personality: "bold captain of the starlight dock" },
    { name: "Bob",      color: 0x80ed99, personality: "easygoing fisher with endless patience" },
  ],

  happenings: [
    "The Open Workshop",
    "Lantern Lighting at the Café",
    "Night Market by the Dock",
    "Moth Trail Expedition",
    "Story Circle in the Garden",
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
