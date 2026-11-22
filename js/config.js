// Site-wide settings. Edit these before you launch.
window.LADDER_CONFIG = {
  name: 'Ladder',

  // Puzzle #1 is this date. Everything after counts up from here.
  // (Changing it only renumbers puzzles; which puzzle falls on which day stays the same.)
  launchDate: '2026-11-22',

  // Shown at the end of the share text.
  siteUrl: 'playwordladders.com',

  // Each hint adds this many steps to your score.
  hintPenalty: 1,

  // Google AdSense. Leave the client empty until your account is approved;
  // the ad slots stay hidden until then.
  // client looks like 'ca-pub-1234567890123456'; slot IDs come from the AdSense dashboard.
  adsense: {
    client: '',
    slots: {
      results: '', // inside the results card, after a solve
      footer: '',  // below a finished puzzle (never next to the keyboard)
    },
  },
};
