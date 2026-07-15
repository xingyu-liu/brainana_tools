from pathlib import Path
import numpy as np, nibabel as nib
from scipy.ndimage import map_coordinates
root=Path(__file__).parent/'synthetic'; root.mkdir(exist_ok=True)
# Source with nontrivial RAS affine and smooth field
sd=(18,16,14)
A=np.array([[-1.2,0,0,10.2],[0,-1.0,0,7.5],[0,0,0.8,-4.0],[0,0,0,1]],float)
i,j,k=np.meshgrid(np.arange(sd[0]),np.arange(sd[1]),np.arange(sd[2]),indexing='ij')
src=(3*i+5*j+7*k+0.1*i*j).astype(np.float32)
nib.save(nib.Nifti1Image(src,A),root/'source.nii.gz')
# NMT target and vector field stored as 5D (X,Y,Z,1,3), matching ANTs vector NIfTI layout.
td=(15,17,13)
B=np.array([[-0.9,0,0,8.0],[0,-0.7,0,6.0],[0,0,0.75,-3.0],[0,0,0,1]],float)
ti,tj,tk=np.meshgrid(np.arange(td[0]),np.arange(td[1]),np.arange(td[2]),indexing='ij')
field=np.zeros(td+(1,3),np.float32)
field[...,0,0]=0.35+0.01*tj
field[...,0,1]=-0.20+0.005*ti
field[...,0,2]=0.15+0.004*tk
# exact validated convention
vox=np.vstack([ti.ravel(),tj.ravel(),tk.ravel(),np.ones(ti.size)])
world=(B@vox)[:3]
d=field[...,0,:].reshape(-1,3).T
sw=world+np.diag([-1.,-1.,1.])@d
sv=(np.linalg.inv(A)@np.vstack([sw,np.ones(sw.shape[1])]))[:3]
expected=map_coordinates(src,sv,order=1,mode='constant',cval=0,prefilter=False).reshape(td).astype(np.float32)
nib.save(nib.Nifti1Image(field,B),root/'field.nii.gz')
nib.save(nib.Nifti1Image(np.zeros(td,np.float32),B),root/'nmt_ref.nii.gz')
nib.save(nib.Nifti1Image(expected,B),root/'nmt_expected.nii.gz')
# Scanner target, FSL transform in scaled voxel mm coordinates.
qd=(20,12,10)
C=np.array([[0,0,-1.5,12.0],[0,0.9,0,-5.0],[1.1,0,0,-8.0],[0,0,0,1]],float)
def fslmat(aff,dims,zooms):
    if np.linalg.det(aff[:3,:3])>0:
        return np.array([[-zooms[0],0,0,(dims[0]-1)*zooms[0]],[0,zooms[1],0,0],[0,0,zooms[2],0],[0,0,0,1]],float)
    return np.diag([*zooms,1.])
# map scanner fsl mm to source fsl mm
M=np.array([[1,0,0,1.3],[0,1,0,-0.8],[0,0,1,0.5],[0,0,0,1]],float)
qi,qj,qk=np.meshgrid(np.arange(qd[0]),np.arange(qd[1]),np.arange(qd[2]),indexing='ij')
qvox=np.vstack([qi.ravel(),qj.ravel(),qk.ravel(),np.ones(qi.size)])
tf=fslmat(C,qd,(1.1,0.9,1.5))@qvox
sf=M@tf
sv=np.linalg.inv(fslmat(A,sd,(1.2,1.0,0.8)))@sf
sexp=map_coordinates(src,sv[:3],order=1,mode='constant',cval=0,prefilter=False).reshape(qd).astype(np.float32)
nib.save(nib.Nifti1Image(np.zeros(qd,np.float32),C),root/'scanner_ref.nii.gz')
nib.save(nib.Nifti1Image(sexp,C),root/'scanner_expected.nii.gz')
np.savetxt(root/'scanner_to_t1w.mat',M,fmt='%.9f')
# Import-direction scanner expected: scanner source sampled onto T1w destination.
si,sj,sk=np.meshgrid(np.arange(sd[0]),np.arange(sd[1]),np.arange(sd[2]),indexing='ij')
tvox=np.vstack([si.ravel(),sj.ravel(),sk.ravel(),np.ones(si.size)])
tf=fslmat(A,sd,(1.2,1.0,0.8))@tvox
qf=np.linalg.inv(M)@tf
qv=np.linalg.inv(fslmat(C,qd,(1.1,0.9,1.5)))@qf
scanner_import_expected=map_coordinates(sexp,qv[:3],order=1,mode='constant',cval=0,prefilter=False).reshape(sd).astype(np.float32)
nib.save(nib.Nifti1Image(scanner_import_expected,A),root/'scanner_import_expected.nii.gz')
# Import-direction NMT expected with reverse displacement defined on T1w grid.
reverse=np.zeros(sd+(1,3),np.float32)
reverse[...,0,0]=-0.18+0.003*sj
reverse[...,0,1]=0.12+0.002*si
reverse[...,0,2]=-0.08+0.002*sk
world=(A@tvox)[:3]
d=reverse[...,0,:].reshape(-1,3).T
nworld=world+np.diag([-1.,-1.,1.])@d
nv=(np.linalg.inv(B)@np.vstack([nworld,np.ones(nworld.shape[1])]))[:3]
nmt_import_expected=map_coordinates(expected,nv,order=1,mode='constant',cval=0,prefilter=False).reshape(sd).astype(np.float32)
nib.save(nib.Nifti1Image(reverse,A),root/'reverse_field.nii.gz')
nib.save(nib.Nifti1Image(nmt_import_expected,A),root/'nmt_import_expected.nii.gz')
