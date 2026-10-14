"""
verdict3.py —— 最后一问：原稿的边界写法（零填充 + G[0] = -F[0]）
              在"速度正确、初值按半直线给 (F=G=0.5*phi(x), x>=0)"时，到底成不成立？
对照三种初值/边界组合，域 x∈[0,8]，dx=dt=0.005 (c=1，每步一格)。
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

DX = DT = 0.005
x = DX * np.arange(1601)          # 0 .. 8

def run(init, T):
    if init == "half":            # 半直线初值：F=G=0.5*phi(x)
        F = 0.5 * phi(x); G = 0.5 * phi(x)
    else:                         # 奇延拓初值
        F = 0.5 * odd(x); G = 0.5 * odd(x)
    for k in range(1, int(round(T / DT)) + 1):
        F = np.concatenate(([0.0], F[:-1]))
        G = np.concatenate((G[1:], [0.0]))
        G[0] = -F[0]
    return F + G

print("域 x∈[0,8]，dx=dt=0.005，边界写法固定为 零填充 + G[0]=-F[0]")
print(f"{'t':>5} {'初值':>6} {'max|u-解析|':>13} {'误差峰位置':>11} {'u(x=t)':>10} {'解析u(t,t)':>11}")
for T in (0.5, 1.0, 1.5, 2.0, 3.0):
    for init in ("half", "odd"):
        u = run(init, T)
        e = np.abs(u - exact(x, T)); j = int(np.argmax(e))
        it = int(round(T / DX))
        print(f"{T:>5.1f} {init:>6} {e[j]:>13.2e} {'x='+format(x[j],'.2f'):>11}"
              f" {u[it]:>10.6f} {float(exact(np.array([T]), T)[0]):>11.6f}")
    print()

# 纯解析检查：原稿 t=1.5 / t=3 的公式与"反射波何时回来"是否自洽
print("解析检查（不涉及数值）：左行波 G=0.5*phi(x+t) 首次触达 x=0 的时刻 = 波峰 x=2 走到 0，t=2")
for t in (0.5, 1.0, 1.5, 2.0, 3.0):
    u1 = 0.5 * (odd(1 - t) + odd(1 + t))
    print(f"  t={t:>4.1f}  解析 u(1,t)={float(u1):>10.6f}   "
          f"{'← 尚未反射' if t <= 2 else '← 反射波已回来'}")
