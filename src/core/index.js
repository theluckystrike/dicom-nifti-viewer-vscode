'use strict';
// Entry for the test bundle (nifti-reader-js is ESM-only, so tests load the core through esbuild).
module.exports = {
  ...require('./load'), ...require('./dicom'), ...require('./nifti'), ...require('./series'), ...require('./volume'), ...require('./rle'), dicomdict: require('./dicomdict'),
};
