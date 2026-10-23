# DOCTYN LOCAL COURSE VIDEO AGENT

Build a local-only medical course production pipeline.

Do not implement cloud storage.

## PRIMARY WORKFLOW

The first workflow is:

PPTX presentation
+
DOCX slide-by-slide voiceover
↓
validate slide count
↓
parse narration
↓
generate one TTS audio file per slide
↓
render each slide locally
↓
measure exact audio duration
↓
create one synchronized video segment per slide
↓
concatenate all segments
↓
generate final MP4
↓
generate captions
↓
generate transcript
↓
save everything locally

## INPUT

Use:

./input

Expect:

- exactly one .pptx
- exactly one .docx

Ignore temporary Office files such as:

~$filename.docx
~$filename.pptx

## OUTPUT

Use:

./output/<course-slug>/

Create:

output/<course-slug>/
├── final-video.mp4
├── thumbnail.jpg
├── captions.vtt
├── captions.srt
├── transcript.txt
├── course.json
├── presentation.pptx
├── voiceover-script.docx
├── slides/
├── audio/
├── video-segments/
├── source/
└── qa/

## DOCX FORMAT

Narration documents contain sections like:

Slide 01 — Risk Factors for Diabetes
VOICEOVER

Welcome to this module...

Slide 02 — Why Risk Factor Assessment Is Critical
VOICEOVER

Diabetes is not an on-and-off disease...

Parse each Slide NN section as exactly one narration record.

Preserve:
- slide number
- title
- narration text

## PPTX VALIDATION

Determine the actual number of slides in the PPTX.

Validation rule:

pptx slide count
=
voiceover section count

If they differ:

DO NOT create the final video.

Create:

qa/validation-error.txt

Include:
- PPTX slide count
- narration count
- missing slide numbers
- duplicate slide numbers
- malformed headings

Exit with a non-zero status.

## AUDIO

Generate one MP3 per slide using OpenAI TTS initially.

File names:

audio/slide-001.mp3
audio/slide-002.mp3
audio/slide-003.mp3

Use leading zeros.

TTS configuration must come from .env.

Do not hard-code API keys.

Normalize spoken medical notation when useful without changing meaning.

Examples:

β-cell -> beta cell
HbA1c -> H B A one C
mg/dL -> milligrams per decilitre
kg/m² -> kilograms per square metre

## SLIDE RENDERING

Use LibreOffice headlessly.

Preferred workflow:

PPTX
→ PDF
→ one image per page

Use FFmpeg, pdftoppm, ImageMagick or another locally available method to produce PNG images.

Final image format:

1920x1080 PNG

Naming:

slides/slide-001.png
slides/slide-002.png

Do not distort aspect ratio.

Use padding if required.

## AUDIO DURATION

Use ffprobe to measure exact MP3 duration.

Do not estimate duration using word count.

## VIDEO SEGMENTS

For every slide:

slide image
+
corresponding MP3
↓
video-segments/slide-001.mp4

The visual must stay visible for the full narration duration.

Use:

H.264
AAC
1920x1080
yuv420p

## FINAL VIDEO

Concatenate all slide segments in exact numerical order.

Create:

final-video.mp4

Use:

-c:v libx264
-c:a aac
-pix_fmt yuv420p
-movflags +faststart

The final video is the main learner-facing deliverable.

## CAPTIONS

Create:

captions.vtt
captions.srt

Use narration timing based on actual audio durations.

Each slide narration should occupy its corresponding slide time window.

## TRANSCRIPT

Create:

transcript.txt

Format:

Slide 01 — Title

Narration...

Slide 02 — Title

Narration...

## THUMBNAIL

Create:

thumbnail.jpg

Use slide 1 as the source.

Prefer 1280x720 JPEG.

## COURSE JSON

Create course.json:

{
  "courseTitle": "",
  "slideCount": 0,
  "durationSeconds": 0,
  "video": "final-video.mp4",
  "thumbnail": "thumbnail.jpg",
  "captions": {
    "vtt": "captions.vtt",
    "srt": "captions.srt"
  },
  "transcript": "transcript.txt",
  "status": "complete"
}

## SOURCE COPY

Copy original PPTX and DOCX into:

source/

Also retain:

presentation.pptx
voiceover-script.docx

in the course root for convenience.

## CHECKPOINTS

Create:

checkpoint.json

Stages:

input_detected
pptx_parsed
docx_parsed
validated
audio_generated
slides_rendered
segments_generated
captions_generated
video_generated
final_validation

If a stage is complete and its files still exist, reuse them.

Do not regenerate 52 audio files because one later video step failed.

## REQUIRED COMMANDS

Implement:

npm run test-services

This should check:

- Node
- input folder
- output folder
- OpenAI environment variable
- FFmpeg
- ffprobe
- LibreOffice

Do not make a paid OpenAI API call during test-services unless explicitly requested.

Implement:

npm run validate

This should:
- detect PPTX
- detect DOCX
- count PPTX slides
- parse narration
- compare counts
- report mapping

Implement:

npm run build-course

This should run the complete pipeline.

## TECHNOLOGY

Use TypeScript.

Use:
- mammoth for DOCX
- JSZip/XML parsing if needed for PPTX slide count
- OpenAI SDK for TTS
- child_process for FFmpeg, ffprobe and LibreOffice
- sharp where useful for image conversion/resizing

## WINDOWS + GIT BASH

This project runs on Windows from Git Bash.

Handle Windows executable paths robustly.

LibreOffice commonly exists at:

C:\Program Files\LibreOffice\program\soffice.exe

Support that path.

## LOCAL STORAGE ONLY

Do not implement:

AWS
S3
Cloudflare R2
Azure Blob
Google Cloud Storage
CDNs
portal uploads
remote file hosting

Everything must remain inside the local project output folder.

## ERROR HANDLING

Errors must be readable.

Bad:

Error code 1

Good:

LibreOffice was not found.
Checked:
C:\Program Files\LibreOffice\program\soffice.exe
and PATH.

Install LibreOffice or configure LIBREOFFICE_PATH in .env.

## FINAL VALIDATION

Before declaring success verify:

slide count
=
narration count
=
PNG count
=
MP3 count
=
video segment count

Also verify:

final-video.mp4 exists
final-video.mp4 duration > 0
captions.vtt exists
captions.srt exists
thumbnail.jpg exists
course.json exists

Print a final summary such as:

COURSE BUILD COMPLETE

Course: Risk Factors for Diabetes
Slides: 52
Voiceovers: 52
Audio files: 52
Video segments: 52
Duration: 24m 31s

Output:
C:\...\output\risk-factors-for-diabetes\final-video.mp4

Validation: PASS
