"""Reads the generated samples with pydicom and nibabel (independent MIT readers) and writes reference numbers.
Usage: python crosscheck.py <samples dir> <out json>"""
import json, sys, os
import numpy as np, pydicom, nibabel as nib
S, out = sys.argv[1], sys.argv[2]
ref = {}
def dcm(rel):
    d = pydicom.dcmread(os.path.join(S, rel))
    a = d.pixel_array.astype(np.float64)
    if 'RescaleSlope' in d: a = a * float(d.RescaleSlope) + float(d.RescaleIntercept)
    r = {'ts': str(d.file_meta.TransferSyntaxUID), 'shape': list(a.shape), 'sum': float(a.sum()), 'min': float(a.min()), 'max': float(a.max()),
         'patientName': str(d.get('PatientName', '')), 'patientId': str(d.get('PatientID', '')), 'elements': len(d)}
    if a.ndim >= 2 and d.SamplesPerPixel == 1:
        f = a if a.ndim == 2 else a[a.shape[0] // 2]
        r['center'] = float(f[f.shape[0] // 2, f.shape[1] // 2]); r['p_10_20'] = float(f[10, 20]) if f.shape[0] > 20 else None
    return r
for rel in ['head-ct-with-name.dcm', 'head-ct-big-endian.dcm', 'head-ct-deflated.dcm', 'mr-brain-rle-multiframe.dcm', 'us-rgb.dcm', 'head-ct/head-017.dcm']:
    ref[rel] = dcm(rel)
j = pydicom.dcmread(os.path.join(S, 'jpeg2000-not-supported.dcm'))
ref['jpeg2000-not-supported.dcm'] = {'ts': str(j.file_meta.TransferSyntaxUID), 'elements': len(j)}
dd = pydicom.dcmread(os.path.join(S, 'chest-ct', 'DICOMDIR'))
ref['DICOMDIR'] = {'records': len(dd.DirectoryRecordSequence), 'first': list(dd.DirectoryRecordSequence[0].ReferencedFileID)}
zs = []
for i in range(1, 49):
    d = pydicom.dcmread(os.path.join(S, 'chest-ct', 'CT', f'IM{i:06d}'))
    zs.append((float(d.ImagePositionPatient[2]), int(d.InstanceNumber), float((d.pixel_array.astype(np.float64) * float(d.RescaleSlope) + float(d.RescaleIntercept)).sum())))
zs.sort()
ref['chest'] = {'count': len(zs), 'z_first': zs[0][0], 'z_last': zs[-1][0], 'sum_by_z': [z[2] for z in zs], 'instance_by_z': [z[1] for z in zs]}
n = nib.load(os.path.join(S, 'brain-phantom.nii.gz'))
a = np.asarray(n.dataobj, dtype=np.float64)
ref['brain-phantom.nii.gz'] = {'shape': list(a.shape), 'sum': float(a.sum()), 'max': float(a.max()), 'axcodes': list(nib.aff2axcodes(n.affine)), 'zooms': [float(z) for z in n.header.get_zooms()], 'v_64_75_55': float(a[64, 75, 55])}
f = nib.load(os.path.join(S, 'sphere-4d.nii'))
b = np.asarray(f.dataobj, dtype=np.float64)
ref['sphere-4d.nii'] = {'shape': list(b.shape), 'sum_t0': float(b[..., 0].sum()), 'sum_t2': float(b[..., 2].sum())}
json.dump(ref, open(out, 'w'), indent=1)
print('ok', len(ref))
