/* Settings for the study copy of the 98% Library. Edit the values, save, and upload this file.
   Public library: keep studyMode false. Study copy: set studyMode true and paste your Google Sheet address (see STUDY-SETUP.md). */
window.LIBRARY_CONFIG = {
  studyMode: true,           // true = participant codes; reading times, word taps, answers and ratings are recorded
  logUrl: 'https://script.google.com/macros/s/AKfycbwkr5hETyI6x5srLyuKKxmAQF1triTdGGQzLCFOuEcHscuo2jRtqdVgTB8L425nQ9Me/exec',
                             // ↑ your Google Apps Script web app address (it ends in /exec)
  logKey: '',                // optional: the same word as KEY in Code.gs, so the sheet accepts records only from your site
  validCodes: ['A01', 'A02'],            // allowed participant codes, e.g. ['A01', 'A02', 'B01']; leave empty to accept any code
  currentTestPoint: null,    // the timed reading test that is open now: 'pre', 'mid', 'post', or null for none
  showTimer: false,          // show a running clock while reading (off by default, because a visible clock can change reading speed)
  hideTextDuringQuiz: true,  // hide the story after "I've finished reading", so questions are answered from memory
  showReadingFeedback: true, // after each question, show right or wrong; after each story, show words per minute and score
  showTestResults: false,    // after a reading test, show the student their words per minute and score
  pauseSeconds: 60           // a gap this long with no scrolling, tapping or typing is recorded as a pause
};
