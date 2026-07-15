#!/usr/bin/env python3
from __future__ import annotations
import argparse
from pathlib import Path
import nibabel as nib
import numpy as np
from scipy.ndimage import map_coordinates


def parse_args():
    p=argparse.ArgumentParser(description='Test Brainana displacement-field conventions by warping native T1w to NMT and comparing with Brainana output.')
    p.add_argument('--t1',required=True,type=Path)
    p.add_argument('--warp',required=True,type=Path)
    p.add_argument('--reference',required=True,type=Path)
    p.add_argument('--outdir',required=True,type=Path)
    p.add_argument('--write-all',action='store_true',help='Write all four candidate warped images, not only the best.')
    return p.parse_args()


def load_field(path):
    img=nib.load(str(path))
    d=np.asarray(img.dataobj,dtype=np.float32)
    d=np.squeeze(d)
    if d.ndim!=4 or d.shape[-1]!=3:
        raise ValueError(f'Expected (X,Y,Z,3) vector field, got {d.shape}')
    return img,d


def metrics(warped, ref):
    finite=np.isfinite(warped)&np.isfinite(ref)
    # compare in an anatomical mask based on the supplied NMT image
    thresh=np.percentile(ref[finite & (ref>0)], 5) if np.any(finite & (ref>0)) else 0
    mask=finite & (ref>thresh)
    a=warped[mask].astype(np.float64); b=ref[mask].astype(np.float64)
    corr=float(np.corrcoef(a,b)[0,1]) if a.size>1 else float('nan')
    # Linear intensity fit, because interpolation/output scaling can differ slightly
    A=np.column_stack([a,np.ones_like(a)])
    slope,intercept=np.linalg.lstsq(A,b,rcond=None)[0]
    fit=a*slope+intercept
    mae=float(np.mean(np.abs(fit-b)))
    rmse=float(np.sqrt(np.mean((fit-b)**2)))
    return corr,mae,rmse,float(slope),float(intercept),int(mask.sum())


def warp_candidate(t1_img, field_img, field, ref_img, vector_matrix, sign):
    shape=ref_img.shape[:3]
    if tuple(field.shape[:3])!=tuple(shape):
        raise ValueError(f'Field grid {field.shape[:3]} does not match reference grid {shape}')
    if not np.allclose(field_img.affine,ref_img.affine,atol=1e-4):
        raise ValueError('Field and reference affines do not match')
    src=np.asarray(t1_img.dataobj,dtype=np.float32)
    inv_src_aff=np.linalg.inv(t1_img.affine)
    out=np.empty(shape,dtype=np.float32)
    nx,ny,nz=shape
    # Work slice-wise to limit memory use.
    ii,jj=np.meshgrid(np.arange(nx,dtype=np.float64),np.arange(ny,dtype=np.float64),indexing='ij')
    ones=np.ones(ii.size,dtype=np.float64)
    for k in range(nz):
        kk=np.full(ii.size,k,dtype=np.float64)
        vox=np.vstack([ii.ravel(),jj.ravel(),kk,ones])
        world=(ref_img.affine@vox)[:3]
        disp=field[:,:,k,:].reshape(-1,3).T.astype(np.float64)
        disp=vector_matrix@disp
        source_world=world + sign*disp
        source_vox=(inv_src_aff@np.vstack([source_world,ones]))[:3]
        vals=map_coordinates(src,source_vox,order=1,mode='constant',cval=0.0,prefilter=False)
        out[:,:,k]=vals.reshape(nx,ny)
    return out


def save_like(data,ref_img,path):
    hdr=ref_img.header.copy(); hdr.set_data_dtype(np.float32)
    img=nib.Nifti1Image(data.astype(np.float32),ref_img.affine,hdr)
    img.set_qform(ref_img.affine,int(ref_img.header['qform_code']))
    img.set_sform(ref_img.affine,int(ref_img.header['sform_code']))
    nib.save(img,str(path))


def main():
    a=parse_args(); a.outdir.mkdir(parents=True,exist_ok=True)
    t1=nib.load(str(a.t1)); field_img,field=load_field(a.warp); ref=nib.load(str(a.reference)); ref_data=np.asarray(ref.dataobj,dtype=np.float32)
    variants={
      'native_plus':(np.eye(3),+1),
      'native_minus':(np.eye(3),-1),
      'lps_to_ras_plus':(np.diag([-1.,-1.,1.]),+1),
      'lps_to_ras_minus':(np.diag([-1.,-1.,1.]),-1),
    }
    results=[]; images={}
    for name,(mat,sign) in variants.items():
        print(f'Testing {name}...',flush=True)
        w=warp_candidate(t1,field_img,field,ref,mat,sign)
        m=metrics(w,ref_data)
        results.append((name,*m)); images[name]=w
        if a.write_all:
            save_like(w,ref,a.outdir/f'{name}.nii.gz')
    results.sort(key=lambda r:(-np.nan_to_num(r[1],nan=-999),r[3]))
    best=results[0][0]
    save_like(images[best],ref,a.outdir/'warped_T1w_to_NMT_best.nii.gz')
    save_like(images[best]-ref_data,ref,a.outdir/'difference_best_minus_brainana.nii.gz')
    lines=['variant\tcorrelation\tMAE_after_linear_fit\tRMSE_after_linear_fit\tslope\tintercept\tn_voxels']
    for r in results:
        lines.append(f'{r[0]}\t{r[1]:.8f}\t{r[2]:.8f}\t{r[3]:.8f}\t{r[4]:.8f}\t{r[5]:.8f}\t{r[6]}')
    lines.append(f'\nBEST={best}')
    (a.outdir/'metrics.tsv').write_text('\n'.join(lines)+'\n')
    print('\n'.join(lines))
    print(f'Best image: {a.outdir / "warped_T1w_to_NMT_best.nii.gz"}')

if __name__=='__main__': main()
