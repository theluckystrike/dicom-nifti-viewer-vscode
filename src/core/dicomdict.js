'use strict';
// A compact DICOM data dictionary for the tag table: tag -> [VR, name]. Common tags only.
// Tags that are not listed show their VR from the file (explicit VR) and the name "Unknown tag" or "Private tag".
const RAW = `
00020000 UL File Meta Information Group Length
00020001 OB File Meta Information Version
00020002 UI Media Storage SOP Class UID
00020003 UI Media Storage SOP Instance UID
00020010 UI Transfer Syntax UID
00020012 UI Implementation Class UID
00020013 SH Implementation Version Name
00020016 AE Source Application Entity Title
00041130 CS File-set ID
00041200 UL Offset of the First Directory Record
00041202 UL Offset of the Last Directory Record
00041212 US File-set Consistency Flag
00041220 SQ Directory Record Sequence
00041400 UL Offset of the Next Directory Record
00041410 US Record In-use Flag
00041420 UL Offset of Referenced Lower-Level Directory Entity
00041430 CS Directory Record Type
00041500 CS Referenced File ID
00041510 UI Referenced SOP Class UID in File
00041511 UI Referenced SOP Instance UID in File
00041512 UI Referenced Transfer Syntax UID in File
00080005 CS Specific Character Set
00080008 CS Image Type
00080012 DA Instance Creation Date
00080013 TM Instance Creation Time
00080016 UI SOP Class UID
00080018 UI SOP Instance UID
00080020 DA Study Date
00080021 DA Series Date
00080022 DA Acquisition Date
00080023 DA Content Date
00080030 TM Study Time
00080031 TM Series Time
00080032 TM Acquisition Time
00080033 TM Content Time
00080050 SH Accession Number
00080060 CS Modality
00080064 CS Conversion Type
00080070 LO Manufacturer
00080080 LO Institution Name
00080081 ST Institution Address
00080090 PN Referring Physician's Name
00081010 SH Station Name
00081030 LO Study Description
0008103E LO Series Description
00081040 LO Institutional Department Name
00081050 PN Performing Physician's Name
00081070 PN Operators' Name
00081090 LO Manufacturer's Model Name
00100010 PN Patient's Name
00100020 LO Patient ID
00100021 LO Issuer of Patient ID
00100030 DA Patient's Birth Date
00100040 CS Patient's Sex
00101000 LO Other Patient IDs
00101001 PN Other Patient Names
00101010 AS Patient's Age
00101020 DS Patient's Size
00101030 DS Patient's Weight
00101040 LO Patient's Address
00102154 SH Patient's Telephone Numbers
00104000 LT Patient Comments
00120062 CS Patient Identity Removed
00120063 LO De-identification Method
00180010 LO Contrast/Bolus Agent
00180015 CS Body Part Examined
00180020 CS Scanning Sequence
00180021 CS Sequence Variant
00180022 CS Scan Options
00180023 CS MR Acquisition Type
00180050 DS Slice Thickness
00180060 DS KVP
00180080 DS Repetition Time
00180081 DS Echo Time
00180082 DS Inversion Time
00180087 DS Magnetic Field Strength
00180088 DS Spacing Between Slices
00181020 LO Software Versions
00181030 LO Protocol Name
00181100 DS Reconstruction Diameter
00181150 IS Exposure Time
00181151 IS X-Ray Tube Current
00181152 IS Exposure
00181210 SH Convolution Kernel
00181310 US Acquisition Matrix
00181314 DS Flip Angle
00185100 CS Patient Position
0020000D UI Study Instance UID
0020000E UI Series Instance UID
00200010 SH Study ID
00200011 IS Series Number
00200012 IS Acquisition Number
00200013 IS Instance Number
00200020 CS Patient Orientation
00200032 DS Image Position (Patient)
00200037 DS Image Orientation (Patient)
00200052 UI Frame of Reference UID
00201040 LO Position Reference Indicator
00201041 DS Slice Location
00204000 LT Image Comments
00280002 US Samples per Pixel
00280004 CS Photometric Interpretation
00280006 US Planar Configuration
00280008 IS Number of Frames
00280009 AT Frame Increment Pointer
00280010 US Rows
00280011 US Columns
00280030 DS Pixel Spacing
00280034 IS Pixel Aspect Ratio
00280100 US Bits Allocated
00280101 US Bits Stored
00280102 US High Bit
00280103 US Pixel Representation
00280106 US Smallest Image Pixel Value
00280107 US Largest Image Pixel Value
00280120 US Pixel Padding Value
00281050 DS Window Center
00281051 DS Window Width
00281052 DS Rescale Intercept
00281053 DS Rescale Slope
00281054 LO Rescale Type
00281055 LO Window Center & Width Explanation
00282110 CS Lossy Image Compression
00282112 DS Lossy Image Compression Ratio
00282114 CS Lossy Image Compression Method
00321032 PN Requesting Physician
00321060 LO Requested Procedure Description
00400244 DA Performed Procedure Step Start Date
00400245 TM Performed Procedure Step Start Time
00400253 SH Performed Procedure Step ID
00400254 LO Performed Procedure Step Description
00081150 UI Referenced SOP Class UID
00081155 UI Referenced SOP Instance UID
00081140 SQ Referenced Image Sequence
00082111 ST Derivation Description
52009229 SQ Shared Functional Groups Sequence
52009230 SQ Per-frame Functional Groups Sequence
7FE00010 OW Pixel Data
FFFEE000 NA Item
FFFEE00D NA Item Delimitation Item
FFFEE0DD NA Sequence Delimitation Item
`;

const DICT = Object.create(null);
for (const line of RAW.split('\n')) {
  const m = /^([0-9A-F]{8}) (\w\w) (.+)$/.exec(line.trim());
  if (m) DICT[m[1]] = [m[2], m[3]];
}

/** "x00100010" (dicom-parser key) -> "(0010,0010)" */
function tagLabel(key) {
  const k = key.replace(/^x/, '').toUpperCase();
  return `(${k.slice(0, 4)},${k.slice(4)})`;
}

function lookup(key) {
  const k = key.replace(/^x/, '').toUpperCase();
  const hit = DICT[k];
  if (hit) return { vr: hit[0], name: hit[1] };
  const group = parseInt(k.slice(0, 4), 16);
  if (group % 2 === 1) return { vr: '', name: 'Private tag' };
  if (k.slice(4) === '0000') return { vr: 'UL', name: 'Group Length' };
  return { vr: '', name: 'Unknown tag' };
}

module.exports = { DICT, lookup, tagLabel };
