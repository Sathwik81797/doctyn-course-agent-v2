// @ts-check
// Videos that already exist in the private Vercel Blob store and are shown in Generated Videos when the site runs in
// "library mode" (no Postgres, no S3). Add an entry here to register another uploaded video; never put URLs or
// tokens in this file — only pathnames. Every file is streamed through the authenticated /api/v3 endpoint.

/**
 * @typedef {Object} LibraryFile
 * @property {string} pathname   pathname inside the private Blob store
 * @property {number} [bytes]    size, shown before the first request
 * @property {boolean} [draft]   true while the content is not clinically approved
 */
/**
 * @typedef {Object} LibraryVideo
 * @property {string} id
 * @property {string} title
 * @property {number} slideCount
 * @property {number} durationSeconds
 * @property {string} completedAt
 * @property {{ animated?: LibraryFile, video?: LibraryFile, thumbnail?: LibraryFile, vtt?: LibraryFile, srt?: LibraryFile, transcript?: LibraryFile }} files
 */

/** @type {LibraryVideo[]} */
export const LIBRARY_VIDEOS = [
  {
    id: "diabetes-enhanced-draft",
    title: "Risk Factors for Diabetes – From Genetics to Lifestyle",
    slideCount: 52,
    // 915.2 s = 15:15 (measured with ffprobe on the file that was uploaded)
    durationSeconds: 915.2,
    completedAt: "2026-10-24T08:33:43.000Z",
    files: {
      // Enhanced animated version. A ".draft." render: 0 of 52 slides are clinically approved.
      animated: { pathname: "courses/diabetes/enhanced/animated-video.enhanced.draft.mp4", bytes: 82287474, draft: true },
    },
  },
];
