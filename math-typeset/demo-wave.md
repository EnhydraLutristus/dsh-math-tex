# 半无界弦上的高斯鼓包：达朗贝尔解与固定端反射

取初值 $u_t(x,0)=0$，则达朗贝尔公式只剩第一项：

$$
u(x,t)=\underbrace{\tfrac12\varphi(x-t)}_{\text{右行波 }F}+\underbrace{\tfrac12\varphi(x+t)}_{\text{左行波 }G}
$$

## 第 2 步：写出反射规则

固定端 $u(0,t)=0$ 要求对初值作**奇延拓** $\tilde\varphi(\xi)=-\varphi(-\xi)$（$\xi<0$），于是

$$
u(x,t)=\frac{\tilde\varphi(x-t)+\varphi(x+t)}{2}
=\begin{cases}
\dfrac12\bigl[\varphi(x-t)+\varphi(x+t)\bigr], & x\ge t\\[4pt]
\dfrac12\bigl[-\varphi(t-x)+\varphi(x+t)\bigr], & x<t
\end{cases}
$$

## 第 3 步：算出数值（取 $x=1$）

| $t$ | $u(1,t)$ | 状态 |
| --- | --- | --- |
| 0 | $+0.367879$ | 初始鼓包本体 |
| 1 | $+0.509158$ | 右行波扫过，未反射 |
| 1.5 | $+0.336701$ | 反射波开始抵消 |
| 3 | $-0.490842$ | 只剩反相反射波 |

```text
F[i] = 0.5*phi(x_i)          # 分解成两支半高的波
G[i] = 0.5*phi(x_i)
每一步: F 右移一格, G 左移一格
边界:   G[0] = -F[0]         # 固定端反射 = 加负号
输出:   u[i] = F[i] + G[i]
```

结论：鼓包撞上固定端后**反相**弹回，此后一直向右传去、不再返回。
