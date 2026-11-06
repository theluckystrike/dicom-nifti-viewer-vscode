# DICOM Viewer & NIfTI Viewer for CT and MRI

Open CT and MRI scans in VS Code (single `.dcm` files, DICOM folders, `.nii` and `.nii.gz`) and scroll, window and inspect them without leaving the editor.

![DICOM Viewer showing a chest CT phantom in the lung window with the tag table beside it](images/chest-ct.png)

*Screenshot of VS Code 1.142 with a synthetic chest phantom made by `scripts/make-samples.js`. No patient data was used anywhere in this project.*

- Window presets for CT brain, soft tissue, lung and bone, or drag on the image to set width and level yourself.
- Axial, coronal and sagittal views of any series or volume, with the real slice spacing.
- The value under the cursor, in HU for CT, and a searchable tag table for every slice.
- A warning bar when Patient's Name or Patient ID is filled, so you don't commit data that isn't anonymized.
- Works offline. The scan is never changed.

## Quick start

1. Install DICOM Viewer & NIfTI Viewer for CT and MRI.
2. Click a `.dcm`, `.nii` or `.nii.gz` file, or a `DICOMDIR`. For a folder of slices, right-click the folder and pick Open Folder as DICOM Series.

## What you can do

| Action | How |
|---|---|
| Next or previous slice | Scroll, the arrow keys, Page Up and Page Down, or the slider |
| Window and level | Drag on the image (left and right for width, up and down for level), or type W and L |
| Presets | 1 CT brain (W 80, L 40), 2 soft tissue (W 400, L 40), 3 lung (W 1500, L -600), 4 bone (W 1800, L 400), 0 auto. The window stored in the file is also there |
| Views | Axial, Coronal and Sagittal buttons, or A, C and S |
| Zoom and pan | Ctrl or Cmd and scroll to zoom at the cursor, Shift and drag (or the right button) to pan, F or a double-click to fit |
| Invert | Invert button or I. MONOCHROME1 images open inverted already |
| Tags | Tags button or T. Search by tag number, name or value, double-click a row to copy it |
| Export | Export PNG saves the slice you see at its real proportions |

![A coronal reformat of the chest phantom in the bone window](images/coronal.png)

The bar under the image shows the voxel under the cursor as i, j and k, then the value. CT values are in Hounsfield units with the stored pixel value next to them. Letters on the image edges (R, L, A, P, S, I) show the patient direction when the file says it.

## Anonymity check

DICOM Viewer reads Patient's Name (0010,0010) and Patient ID (0010,0020) in every file of the series. When either is filled, a yellow bar names the values and counts the files, and those rows are marked in the tag table. It also lists other identifying tags it finds, such as the birth date, address, accession number or institution. When both are empty, a short grey line says so.

It's a check, not a de-identification tool. Burned-in text in the pixels and private tags aren't checked.

![The warning bar for a phantom file with a made-up name and ID](images/tags-warning.png)

## Formats

| Format | What opens |
|---|---|
| DICOM transfer syntaxes | Implicit VR Little Endian, Explicit VR Little Endian, Explicit VR Big Endian, Deflated Explicit VR Little Endian and RLE Lossless |
| Not supported yet | JPEG Baseline, JPEG Extended, JPEG Lossless, JPEG-LS, JPEG 2000, HTJ2K and MPEG or HEVC video. These files still open with their full tag table and a message that names the transfer syntax |
| DICOM pixels | 8, 16 and 32 bit, signed or unsigned, MONOCHROME1, MONOCHROME2, RGB and YBR_FULL, single frame and multi-frame, Rescale Slope and Intercept applied |
| DICOM folders | A `DICOMDIR` (its Referenced File IDs), or any folder with `.dcm`, `.dicom` or `.ima` files or files without an extension, 4 folders deep. Slices are sorted by Image Position (Patient). With several series you pick one from a list |
| NIfTI | NIfTI-1 and NIfTI-2, `.nii` and `.nii.gz`, uint8 to float64 and RGB, with scl_slope and the sform or qform orientation. A 4D file shows one volume at a time, with a picker |

![A NIfTI brain phantom in the sagittal view with its header fields](images/nifti.png)

## Big scans

Files are read in a worker thread, so VS Code stays responsive. A 48-slice 256 x 256 series stacks in well under a second. Scans over 1024 MB (for `.nii.gz`, the unpacked size) show a message and aren't read. You can raise the limit with `dicomViewer.maxFileMB`, up to 4096.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `dicomViewer.maxFileMB` | 1024 | Largest file or folder that is read |
| `dicomViewer.defaultView` | auto | View a scan opens in. Auto uses the plane the slices were stored in |
| `dicomViewer.smoothing` | false | Smooth pixels when zoomed |
| `dicomViewer.askForRating` | true | Ask one time for a Marketplace rating after a few days of use |
| `dicomViewer.showSupportLinks` | true | Show the small Sponsor and More free viewers links under the image |

## Privacy

No network calls and no telemetry. The webview has a strict Content-Security-Policy, file text is shown as plain text, and the only file DICOM Viewer writes is the PNG you choose in the save dialog.

## Known limits

- Views follow the stored voxel grid. Oblique scans are shown along their nearest patient axes and aren't resampled.
- Overlays, presentation states, segmentation objects, RT structures and DICOM SR content aren't drawn. Their tags show in the table.
- PALETTE COLOR images and 1-bit pixels aren't decoded.
- Not for diagnosis. It's a developer and research viewer.

## Support

Zovo extensions have no ads and no tracking, and sponsors pay for the time that goes into fixes and new viewers. You can sponsor the work on [GitHub Sponsors](https://github.com/sponsors/theluckystrike).

## More viewers by Zovo

- [Context Drift](https://marketplace.visualstudio.com/items?itemName=zovo.context-drift) finds stale facts in AGENTS.md, CLAUDE.md and other agent rule files.
- [PDF Viewer & Reader with Dark Mode](https://marketplace.visualstudio.com/items?itemName=zovo.pdf-viewer-dark) reads PDFs with a real dark mode, search, an outline and thumbnails.
- [CSV, Excel & Parquet Viewer](https://marketplace.visualstudio.com/items?itemName=zovo.table-viewer-vscode) opens Parquet, Excel and CSV files as a sortable, filterable table.
- [DOCX Viewer & Word Viewer](https://marketplace.visualstudio.com/items?itemName=zovo.docx-viewer-vscode) previews Word files with dark mode, an outline and search.
- [HDF5 & NetCDF Explorer](https://marketplace.visualstudio.com/items?itemName=zovo.hdf5-netcdf-explorer) browses groups, variables and attributes in scientific data files.
- [PPTX Viewer for PowerPoint](https://marketplace.visualstudio.com/items?itemName=zovo.pptx-slide-viewer) shows PowerPoint slides, thumbnails and speaker notes.
- [Skill Shelf](https://marketplace.visualstudio.com/items?itemName=zovo.skill-shelf) lists, checks and toggles the Agent Skills that Claude Code, Codex and Cursor load.
- [Tensor Viewer](https://marketplace.visualstudio.com/items?itemName=zovo.tensor-viewer) shows NPY, NPZ, Safetensors and GGUF tensors with stats and heatmaps.

Coming soon to the Marketplace, with the code on GitHub now.

- [JSONL Viewer](https://github.com/theluckystrike/jsonl-viewer-vscode) opens JSONL and NDJSON files as a table, as records or as a chat view.
- [SQLite Table Viewer](https://github.com/theluckystrike/sqlite-table-viewer) browses SQLite tables read-only and runs SELECT queries.
- [Agent Session Viewer](https://github.com/theluckystrike/agent-session-viewer) browses and searches your local Claude Code and Codex sessions.
- [Audio Preview & Loudness Meter](https://github.com/theluckystrike/audio-preview-vscode) plays audio files with a waveform, a spectrogram and LUFS loudness.
- [Video Preview with Sound](https://github.com/theluckystrike/video-preview-vscode) plays MP4, MOV, MKV and WebM files with their sound.
- [Graphviz Preview & DOT Viewer](https://github.com/theluckystrike/graphviz-preview-vscode) shows a live preview of DOT files and exports SVG or PNG.
- [TIFF Viewer](https://github.com/theluckystrike/tiff-viewer-vscode) opens 16-bit, float, multi-page and GeoTIFF images.
- [Avro, Arrow & Feather Viewer](https://github.com/theluckystrike/arrow-avro-viewer-vscode) opens Avro, Arrow and Feather files as a paged table.
- [EML & MBOX Email Viewer](https://github.com/theluckystrike/eml-viewer-vscode) reads email files with remote images blocked.
- [3D Model Viewer](https://github.com/theluckystrike/model-viewer-vscode) views GLB, glTF, STL, OBJ, PLY and 3MF models.
- [JSON Viewer & JSON Tree](https://github.com/theluckystrike/json-tree-viewer-vscode) shows large JSON files as a searchable tree, copies JSONPath and turns arrays of objects into a table.
- [PKL Viewer & Pickle Viewer](https://github.com/theluckystrike/pickle-viewer-vscode) opens Python pickle files without Python and never runs their code.
- [Claude Code & Codex Usage Meter](https://github.com/theluckystrike/ai-usage-meter-vscode) shows Claude Code and Codex tokens and estimated cost from your local session files.
- [DXF Viewer & CAD Viewer](https://github.com/theluckystrike/dxf-viewer-vscode) opens ASCII and binary DXF drawings with layers, measuring and PNG or SVG export.
- [File Viewers Pack](https://github.com/theluckystrike/zovo-file-viewers) installs the PDF, table, Word, PowerPoint, HDF5 and tensor viewers in one step.

## License

MIT. dicom-parser, nifti-reader-js and fflate are MIT too, see THIRD-PARTY-NOTICES.md.
