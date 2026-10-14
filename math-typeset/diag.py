"""
diag.py —— 两个诊断：
PART 1  原稿算法忠实复刻（dt=0.005, dx=0.01, 每步移一格）：错在哪。
PART 2  正确版（c*dt/dx = 1，即每步移一格 = 物理速度）+ 真正的奇反射边界。
"""
import sys
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
import numpy as np

phi = lambda z: np.exp(-np.asarray(z, float) ** 2)
ptil = lambda z: np.where(np.asarray(z) < 0.0, -phi(-np.asarray(z)), phi(np.asarray(z)))

# ================= PART 1：忠实复刻原稿 =================
DX, DT, N = 0.01, 0.005, 1001
x = -2.0 + DX * np.arange(N)
F = 0.5 * ptil(x)
G = 0.5 * ptil(x)
snap = {}
for k in range(1, 601):
    F = np.concatenate(([0.0], F[:-1]))
    G = np.concatenate((G[1:], [0.0]))
    G[0] = -F[0]
    if k in (200, 400, 600):
        snap[k] = F + G
print("PART 1  原稿算法（每步移一格，物理速度应为 200 格/步）")
print("  → 波速慢了 200 倍：t=3 时波峰只从 x=0 走到 x=3，"
      "而解析解要求走到 x=3 需 600 格 = 6 个空间单位，早跑出题设区间")
for k, u in snap.items():
    j = int(np.argmax(np.abs(u)))
    print(f"  t={k*DT:>4.1f}  非零格点={int(np.count_nonzero(np.abs(u)>1e-12)):>4}/{N}"
          f"  峰值位置 x={x[j]:>6.2f}  峰值={u[j]:>10.3e}  解析u(x=1)={0.5*(ptil(1-k*DT)+ptil(1+k*DT)):>10.6f}")

# ================= PART 2：正确版 =================
print("\nPART 2  正确版（dx=dt=0.06 → 每步恰好一格；奇反射边界）")
DX2 = DT2 = 0.06
x2 = -3.0 + DX2 * np.arange(201)
def solve(T, boundary):
    F = 0.5 * ptil(x2); G = 0.5 * ptil(x2)
    for k in range(1, int(round(T / DT2)) + 1):
        F = np.concatenate(([0.5 * ptil(x2[0] - k * DT2)], F[:-1]))   # 右行波右移
        G = np.concatenate((G[1:], [0.5 * ptil(x2[-1] + k * DT2)]))   # 左行波左移
        if boundary == "odd":                # 真正的奇反射：G_new(x) = -G_old(-x)
            G = -G[::-1]
    return x2, F + G, F, G

for T in (1.0, 1.5, 3.0):
    xg, u, F, G = solve(T, "odd")
    ex = 0.5 * (ptil(xg - T) + ptil(xg + T))
    i1, i3 = int(round((1.0 + 3.0) / DX2)), int(round((3.0 + 3.0) / DX2))
    print(f"  t={T:>4.1f}  max|u-解析|={np.max(np.abs(u-ex)):.3e}"
          f"   u(1)={u[i1]:>10.6f} (解析 {float(ex[i1]):>10.6f})"
          f"   u(3)={u[i3]:>10.6f} (解析 {float(ex[i3]):>10.6f})")
