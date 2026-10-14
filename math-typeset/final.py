"""
final.py —— 1) 原稿算法 vs 解析：速度差 2 倍（物理速度被写成 2 而非 1）
            2) 正确版：c*dt/dx = 1（每步一格，物理速度 = 1）+ 奇延拓边界（等价于固定端）
"""
import sys
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
import numpy as np

phi = lambda z: np.exp(-np.asarray(z, float) ** 2)
odd = lambda z: np.where(np.asarray(z) < 0.0, -phi(-np.asarray(z)), phi(np.asarray(z)))
exact = lambda xq, t: 0.5 * (odd(xq - t) + odd(xq + t))

# ---------- STEP 1：原稿 dt=0.005 / dx=0.01，每步移一格 → 隐含速度 = 0.01/0.005 = 2 ----------
DX, DT, N = 0.01, 0.005, 1001
xg = -2.0 + DX * np.arange(N)
F = 0.5 * odd(xg); G = 0.5 * odd(xg)
print("STEP 1  原稿算法（每步移一格，隐含 c = dx/dt = 2，而题目是 c = 1）")
print(f"{'t':>5} {'峰值x':>7} {'u(x=t)':>10} {'解析u(t,t)':>11}  说明")
for k in range(1, 401):
    F = np.concatenate(([0.0], F[:-1]))
    G = np.concatenate((G[1:], [0.0]))
    G[0] = -F[0]
    if k in (100, 200, 400):
        t = k * DT
        u = F + G
        j = int(np.argmax(np.abs(u)))
        it = int(round((t + 2.0) / DX))
        print(f"{t:>5.1f} {xg[j]:>7.2f} {u[it]:>10.4f} {float(exact(t, t)):>11.4f}"
              f"  波前领先 {2*t:>4.1f}，本该在 x={t:.1f}")

# ---------- STEP 2：正确版，速度 = 1，奇延拓 padding ----------
print("\nSTEP 2  正确版（dx = dt = 0.005 → 每步一格，c = 1；边界用奇延拓，不再写 G[0]=-F[0]）")
DX2 = DT2 = 0.005
x2 = -3.0 + DX2 * np.arange(int(9.0 / DX2) + 1)      # x ∈ [-3, 6]
print(f"  网格 {len(x2)} 点，t=3 需 {int(3/DT2)} 步")
for T in (0.5, 1.0, 1.5, 2.0, 3.0):
    F = 0.5 * odd(x2); G = 0.5 * odd(x2)
    for k in range(1, int(round(T / DT2)) + 1):
        # 奇延拓的边界值就是解析值：ξ=x−t 与 ξ=x+t 在网格外直接取 odd()
        F = np.concatenate(([0.5 * odd(x2[0] - k * DT2)], F[:-1]))
        G = np.concatenate((G[1:], [0.5 * odd(x2[-1] + k * DT2)]))
    u = F + G
    ex = exact(x2, T)
    i1, i3 = int(round((1.0 + 3.0) / DX2)), int(round((3.0 + 3.0) / DX2))
    print(f"  t={T:>4.1f}  max|u-解析|={np.max(np.abs(u-ex)):.2e}"
          f"   u(1)={u[i1]:>9.6f} (解析{float(ex[i1]):>9.6f})"
          f"   u(3)={u[i3]:>9.6f} (解析{float(ex[i3]):>9.6f})")
