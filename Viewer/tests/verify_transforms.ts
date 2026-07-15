import { loadRawNifti, resampleNmt, resampleScanner, resampleScannerToT1w, resampleTemplateToT1w, createGaussianRoi, flatIndex, normalizePositive } from '../src/roiWarp.ts'
const base='http://127.0.0.1:8765/'
const [src,nref,field,nexp,sref,sexp,scannerImportExpected,reverseField,nmtImportExpected]=await Promise.all([
  loadRawNifti(base+'source.nii.gz'), loadRawNifti(base+'nmt_ref.nii.gz'), loadRawNifti(base+'field.nii.gz'),
  loadRawNifti(base+'nmt_expected.nii.gz'), loadRawNifti(base+'scanner_ref.nii.gz'), loadRawNifti(base+'scanner_expected.nii.gz'),
  loadRawNifti(base+'scanner_import_expected.nii.gz'), loadRawNifti(base+'reverse_field.nii.gz'), loadRawNifti(base+'nmt_import_expected.nii.gz')
])
const maxDiff=(a:ArrayLike<number>,b:ArrayLike<number>)=>{let m=0;for(let i=0;i<a.length;i++)m=Math.max(m,Math.abs(Number(a[i])-Number(b[i])));return m}
const nmt=resampleNmt(src,nref,field)
const nd=maxDiff(nmt,nexp.values)
if(nd>2e-4) throw new Error(`NMT mismatch maxDiff=${nd}`)
const matrix=[[1,0,0,1.3],[0,1,0,-0.8],[0,0,1,0.5],[0,0,0,1]]
const scanner=resampleScanner(src,sref,matrix)
const sd=maxDiff(scanner,sexp.values)
if(sd>2e-4) throw new Error(`Scanner mismatch maxDiff=${sd}`)
const scannerImported=resampleScannerToT1w(sexp,src,matrix)
const sid=maxDiff(scannerImported,scannerImportExpected.values)
if(sid>2e-4) throw new Error(`Scanner import mismatch maxDiff=${sid}`)
const nmtImported=resampleTemplateToT1w(nexp,src,reverseField)
const nid=maxDiff(nmtImported,nmtImportExpected.values)
if(nid>2e-4) throw new Error(`NMT import mismatch maxDiff=${nid}`)

// Gaussian source integrity and identity-warp preservation.
const extentMm=5
const centerWorld=[0,0,0] as [number,number,number]
const roi=createGaussianRoi(src,centerWorld,extentMm)
const centerIndex=flatIndex(roi.center[0],roi.center[1],roi.center[2],src.dims)
if(roi.values[centerIndex]!==1) throw new Error(`Gaussian center=${roi.values[centerIndex]}`)
let sourceMax=0, sourcePositive=0
for(const v of roi.values){if(!Number.isFinite(v)||v<0||v>1+1e-6)throw new Error(`Invalid source Gaussian value ${v}`);if(v>0)sourcePositive++;sourceMax=Math.max(sourceMax,v)}
if(Math.abs(sourceMax-1)>1e-6||sourcePositive<2)throw new Error(`Invalid Gaussian source max=${sourceMax}, positive=${sourcePositive}`)
const identityTarget={...src, frameCount:1, values:new Float32Array(src.values.length)}
const identityField={...field,dims:src.dims,affine:src.affine,frameCount:3,values:new Float32Array(src.dims[0]*src.dims[1]*src.dims[2]*3)}
const out=resampleNmt(src,identityTarget,identityField,roi.values,'linear')
const preMax=normalizePositive(out)
const gd=maxDiff(out,roi.values)
if(gd>2e-5) throw new Error(`Identity Gaussian mismatch maxDiff=${gd}`)
if(Math.abs(out[centerIndex]-1)>1e-6)throw new Error('Identity Gaussian center is not 1')

// Input validation.
let rejected=false
try{createGaussianRoi(src,centerWorld,0.5)}catch{rejected=true}
if(!rejected)throw new Error('Extent below 1 mm was accepted')
console.log(JSON.stringify({nmtMaxAbsDifference:nd,scannerMaxAbsDifference:sd,scannerImportMaxAbsDifference:sid,nmtImportMaxAbsDifference:nid,sourceGaussianPositiveVoxels:sourcePositive,sourceGaussianMaximum:sourceMax,identityGaussianMaxAbsDifference:gd,identityPreNormalizationMaximum:preMax},null,2))
