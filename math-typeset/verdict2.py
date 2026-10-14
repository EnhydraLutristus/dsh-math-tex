"""
verdict2.py —— 只判两件事：
 (1) 原稿算法在"远离边界"的内部，是否等于 c=2 解析解（即唯一的错是不是速度）
 (2) 只把速度改对、保留 G[0]=-F[0] 与零填充，交界面附近是否正确
评分区域刻意避开 x=x_min 那条人工截断边。
"""
import sys
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
import numpy as np

phi = lambda z: np.exp(-np.asarray(z, float) ** 2)
odd = lambda z: np.where(np.asarray(z) < 0.0, -phi(-np.asarray(z)), phi(np.asarray(z)))
exact = lambda xq, t, c: 0.5 * (odd(xq - c * t) + odd(xq + c * t))

# ===== (1) 原稿：dx=0.01 dt=0.005，每步一格，c_num = 2；域取 x∈[-2,8] 够 c=2 走 =====
DX = 0.01; DT = 0.005
xg = -2.0 + DX * np.arange(1001)
F = 0.5 * odd(xg); G = 0.5 * odd(xg)
print("(1) 原稿算法 vs c=2 解析解，只看内部 (0 ≤ x ≤ 8，即完全避开 x=-2 的人工边界)")
print(f"{'t':>5} {'max|u-c2|':>12} {'max|u-c1|':>12}   u(0,t)数值/c2解析")
for k in range(1, 601):
    F = np.concatenate(([0.0], F[:-1]))
    G = np.concatenate((G[1:], [0.0]))
    G[0] = -F[0]
    if k in (100, 200, 300, 400, 600):
        t = k * DT; u = F + G
        m = xg >= 0.0
        i0 = int(round(2.0 / DX))
        print(f"{t:>5.1f} {np.max(np.abs(u[m]-exact(xg[m],t,2.0))):>12.2e}"
              f" {np.max(np.abs(u[m]-exact(xg[m],t,1.0))):>12.2e}"
              f"   {u[i0]:>9.6f} / {float(exact(np.array([0.0]),t,2.0)[0]):>9.6f}")

# ===== (2) 速度改对，保留原稿边界写法；域 x∈[0,8]，x=0 才是真边界 =====
print("\n(2) 正确速度 (dx=dt=0.005, c=1) + 原稿写法 (零填充 & G[0]=-F[0])，域 x∈[0,8]")
DX2 = 0.005
x2 = DX2 * np.arange(1601)
F = 0.5 * odd(x2); G = 0.5 * odd(x2)
print(f"{'t':>5} {'max|u-解析|':>12} {'u(0,t)':>11} {'解析':>11}   误差峰位置")
for k in range(1, 601):
    F = np.concatenate(([0.0], F[:-1]))
    G = np.concatenate((G[1:], [0.0]))
    G[0] = -F[0]
    if k in (100, 200, 300, 400, 600):
        t = k * DT; u = F + G
        e = np.abs(u - exact(x2, t, 1.0)); j = int(np.argmax(e))
        print(f"{t:>5.1f} {e[j]:>12.2e} {u[0]:>11.3e} {float(exact(np.array([0.0]),t,1.0)[0]):>11.3e}   x={x2[j]:>5.2f}")

# ===== (3) 用 8 格粗网格：一眼看穿"零填充 vs 奇延拓" =====
print("\n(3) 极粗网格 dx=1 的直觉检查（c=1，每步一格），t=1 时 u 的形态")
for name, pad in (("零填充(原稿)", "zero"), ("奇延拓", "odd")):
    n = 12; xc = np.arange(n, dtype=float)
    F = 0.5 * odd(xc); G = 0.5 * odd(xc)
    for k in range(1, 2):
        if pad == "zero":
            F = np.concatenate(([0.0], F[:-1])); G = np.concatenate((G[1:], [0.0]))
            G[0] = -F[0]
        else:
            F = np.concatenate(([0.5 * odd(xc[0] - k)], F[:-1]))
            G = np.concatenate((G[1:], [0.0]))
    print(f"   {name:>12}: u = {np.round(F+G, 4)}")
    print(f"   {'解析':>12}: u = {np.round(exact(xc, 1.0, 1.0), 4)}")
