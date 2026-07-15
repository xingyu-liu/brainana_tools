# Transform validation

`warp_t1_to_nmt_test.py` is the user-supplied validation script that established the Brainana NMT displacement convention.

The additional `tests/` verification creates synthetic NIfTI files with nontrivial orientation, voxel size, and 5D vector-field layout. The TypeScript browser implementation is compared with independent Python/SciPy output for:

- NMT2Sym pull resampling using the validated ITK/LPS vector convention
- Scanner-to-T1w resampling using FSL FLIRT scaled-voxel coordinates
- A 125-voxel source cube
- Identity-warp preservation of all 125 contiguous voxels

Last verified results:

- NMT maximum absolute difference: 0.0000152587890625
- Scanner maximum absolute difference: 0.0000152587890625
- Source cube: 125 voxels
- Identity output: 125 contiguous voxels
