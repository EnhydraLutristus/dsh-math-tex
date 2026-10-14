"""
fix.py —— 修正版：一个时间步走 c*dt/dx = 1 格，与解析解逐格对比。
三种边界处理互相对照：
  (A) 截图写法：  G[0] = -F[0]
  (B) 不做任何人工边界处理（只靠奇延拓已经装进初值里）
  (C) 每步把 G 在 x=0 处按奇反射折回（等价于一直使用奇延拓）
"""
import sys
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
import numpy as np

DX = 0.01
DT = 0.01          # c*dt/dx = 1  → 每步恰好走一格
N = 1001
x = -2.0 + DX * np.arange(N)
idx = lambda v: int(round((v + 2.0) / DX))

phi = lambda z: np.exp(-np.asarray(z, dtype=float) ** 2)
# 奇延拓：ptil(ξ) = φ(ξ) (ξ≥0),  -φ(-ξ) (ξ<0)
ptil = lambda z: np.where(np.asarray(z) < 0.0, -phi(-np.asarray(z)), phi(np.asarray(z)))

exact = lambda xq, t: 0.5 * (ptil(xq - t) + ptil(xq + t))

def run(mode, K, xg):
    F = 0.5 * ptil(xg)
    G = 0.5 * ptil(xg)
    for k in range(1, K + 1):
        F = np.concatenate(([0.5 * ptil(xg[0] - k * DT)], F[:-1]))
        G = np.concatenate((G[1:], [0.5 * ptil(xg[-1] + k * DT)]))
        if mode == "A":
            G[0] = -F[0]
        elif mode == "C":
            neg = G < 0
            Grefl = -G[::-1]
            G = np.where(neg, Grefl, G)
    return F, G

print(f"{'t':>5} {'version':>10} {'max|u-解析|':>13} {'u(1)':>11} {'解析u(1)':>11} {'u(3)':>11} {'解析u(3)':>11}")
for t in (0.5, 1.0, 1.5, 3.0):
    K = int(round(t / DT))
    ex1, ex3 = float(exact(1.0, t)), float(exact(3.0, t))
    for mode, name in (("A", "G[0]=-F[0]"), ("B", "无人工边界"), ("C", "奇反射")):
        F, G = run(mode, K, x)
        u = F + G
        err = float(np.max(np.abs(u - exact(x, t))))
        print(f"{t:>5.1f} {name:>10} {err:>13.3e} {u[idx(1.0)]:>11.6f} {ex1:>11.6f} {u[idx(3.0)]:>11.6f} {ex3:>11.6f}")

# 截图原速（每步一格，dt=0.005）到底发生了什么
print("\n原稿速度 c*dt/dx = 0.5（每步半格，但被量化成整数格）：")
F = 0.5 * ptil(x); G = 0.5 * ptil(x)
for k in range(1, 601):
    F = np.concatenate(([0.0], F[:-1]))
    G = np.concatenate((G[1:], [0.0]))
    G[0] = -F[0]
u = F + G
print("  t=3 时 u 的非零格点个数 =", int(np.count_nonzero(np.abs(u) > 1e-12)), "/", N)
print("  非零处 u =", u[np.abs(u) > 1e-12][:5], " 位置 x =", x[np.abs(u) > 1e-12][:5])
