r"""
check_scheme.py —— 先把"正确的迎风格式"跑通，再回头判断截图那段算法对不对。
关键：达朗贝尔分解必须按【奇延拓】取
    u(x,t) = [ phi~(x-t) + phi~(x+t) ] / 2 ,   phi~(z) = -phi(-z) (z<0)
即  入流支 F(z) = 0.5*phi~(z)      （z<0 取负号）
    出流支 G(z) = 0.5*phi~(z)
运行:  D:\python\python.exe check_scheme.py
"""
import sys
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
import numpy as np

phi = lambda z: np.exp(-np.asarray(z, float) ** 2)
ptil = lambda z: np.where(np.asarray(z, float) < 0, -phi(-np.asarray(z, float)), phi(z))  # 奇延拓

H, CFL, T = 0.01, 0.5, 3.0
DT = CFL * H


def true_u(x, t):
    return 0.5 * (ptil(x - t) + ptil(x + t))


def full_line(T=T):
    """整条实轴 + 奇延拓初值 + 迎风移位（出流侧自然为零，入流侧补精确值）"""
    xs = np.arange(-2.0, 8.0 + H / 2, H)
    F = 0.5 * ptil(xs); G = 0.5 * ptil(xs)        # F[i] ~ phi~(x_i - t)/2, G[i] ~ phi~(x_i + t)/2
    for k in range(1, int(round(T / DT)) + 1):    # F 向右移 => 前方补左边界的值
        F = np.concatenate(([0.5 * ptil(xs[0] - k * DT)], F[:-1]))
        G = np.concatenate((G[1:], [0.5 * ptil(xs[-1] + k * DT)]))
    return xs, F + G


def paper(T=T):
    """照抄截图：半无界 + 人工边界 G[0] = -F[0]"""
    xs = np.arange(0.0, 8.0 + H / 2, H)
    F = 0.5 * phi(xs); G = 0.5 * phi(xs)
    for _ in range(int(round(T / DT))):
        F = np.concatenate(([0.0], F[:-1]))
        G = np.concatenate((G[1:], [0.0]))
        G[0] = -F[0]
    return xs, F + G


def paper_nobc(T=T):
    """只删掉人工边界那一行，其余照抄"""
    xs = np.arange(0.0, 8.0 + H / 2, H)
    F = 0.5 * phi(xs); G = 0.5 * phi(xs)
    for _ in range(int(round(T / DT))):
        F = np.concatenate(([0.0], F[:-1]))
        G = np.concatenate((G[1:], [0.0]))
    return xs, F + G


xsF, uF = full_line()
xsP, uP = paper()
xsN, uN = paper_nobc()

def at(xs, u, x0):
    return float(u[int(round((x0 - xs[0]) / H))])

print(f"{'x':>5} {'解析 u(x,3)':>14} {'整条实轴(参考)':>16} {'照抄截图':>12} {'删掉G[0]=-F[0]':>15}")
for x0 in [0.0, 0.5, 1.0, 2.0, 3.0, 5.0]:
    print(f"{x0:>5} {float(true_u(x0,3.0)):>14.7f} {at(xsF,uF,x0):>16.7f} "
          f"{at(xsP,uP,x0):>12.7f} {at(xsN,uN,x0):>15.7f}")

print("\n整条实轴写法 vs 解析解：全网格最大偏差 =",
      f"{np.max(np.abs(uF - true_u(xsF, 3.0))):.3e}")
