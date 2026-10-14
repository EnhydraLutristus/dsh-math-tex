"""
debug_scheme.py —— 把数组原样打出来，找出"参考写法"为什么不等于解析解。
"""
import sys
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
import numpy as np

H, DT = 0.01, 0.005
phi = lambda z: np.exp(-np.asarray(z, float) ** 2)
ptil = lambda z: np.where(np.asarray(z, float) < 0, -phi(-np.asarray(z, float)), phi(z))
exact = lambda x, t: 0.5 * (ptil(x - t) + ptil(x + t))

xs = np.arange(-2.0, 8.0 + H / 2, H)
N = len(xs)
F = 0.5 * ptil(xs)
G = 0.5 * ptil(xs)
idx = lambda x0: int(round((x0 - xs[0]) / H))

K = int(round(1.0 / DT))          # 推进到 t=1
for k in range(1, K + 1):
    F = np.concatenate(([0.5 * ptil(xs[0] - k * DT)], F[:-1]))
    G = np.concatenate((G[1:], [0.5 * ptil(xs[-1] + k * DT)]))

print(f"t = 1.0, 推进 {K} 步, 数组长度 {N}")
print(f"{'x':>6} {'F':>14} {'G':>14} {'F+G':>14} {'解析':>14}")
for x0 in [0.0, 1.0, 2.0, 3.0, 4.0, 5.0]:
    i = idx(x0)
    print(f"{x0:>6.1f} {F[i]:>14.8f} {G[i]:>14.8f} {F[i]+G[i]:>14.8f} {float(exact(x0,1.0)):>14.8f}")

print("\n非零元分布（|值|>1e-6 的索引区间）:")
nz = np.nonzero(np.abs(F + G) > 1e-6)[0]
if len(nz):
    print(f"  F+G: idx {nz[0]}..{nz[-1]}  -> x = {xs[nz[0]]:.3f}..{xs[nz[-1]]:.3f}")
print("  F 的峰值出现在 x =", f"{xs[np.argmax(F)]:.3f}", " 值", f"{F.max():.6f}")
print("  G 的峰值出现在 x =", f"{xs[np.argmax(G)]:.3f}", " 值", f"{G.max():.6f}")
print("\n  期望: t=1 时 F 峰值应在 x=1+? (F 右行), G 峰值应在 x=1 ? (G 左行)")
print("  解析解在 t=1 的峰值位置 x =", f"{xs[np.argmax(exact(xs,1.0))]:.3f}")
