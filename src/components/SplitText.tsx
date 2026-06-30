/**
 * SplitText - 字符级延迟入场动画(react-bits 简化版 TS+Tailwind)
 * 将文本拆为字符,每个字符按 delay*index 延迟从 opacity:0/y:20 渐入到 opacity:1/y:0
 * 替代 BlurText 用于关键标题,提升视觉品质
 * 用法: <SplitText text="墨铸工坊" className="font-display text-5xl gradient-text" delay={50} />
 */
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

interface SplitTextProps {
  text: string;
  className?: string;
  delay?: number;        // 每字符延迟 ms,默认 50
  animationFrom?: { opacity?: number; y?: number };
  animationTo?: { opacity?: number; y?: number };
  as?: 'h1' | 'h2' | 'h3' | 'p' | 'span';
}

export default function SplitText({
  text,
  className,
  delay = 50,
  animationFrom = { opacity: 0, y: 20 },
  animationTo = { opacity: 1, y: 0 },
  as: Tag = 'h1',
}: SplitTextProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    // 下一帧触发动画,确保 from 态已渲染
    const t = window.setTimeout(() => setMounted(true), 16);
    return () => window.clearTimeout(t);
  }, []);

  const chars = Array.from(text);
  const fromOp = animationFrom.opacity ?? 0;
  const fromY = animationFrom.y ?? 20;
  const toOp = animationTo.opacity ?? 1;
  const toY = animationTo.y ?? 0;

  return (
    <Tag
      className={cn('inline-block', className)}
      aria-label={text}
      aria-hidden={false}
    >
      {chars.map((ch, i) => (
        <span
          key={`${ch}-${i}`}
          className="inline-block transition-all duration-500 ease-out"
          style={{
            opacity: mounted ? toOp : fromOp,
            transform: `translateY(${mounted ? toY : fromY}px)`,
            transitionDelay: `${i * delay}ms`,
            whiteSpace: ch === ' ' ? 'pre' : 'normal',
          }}
        >
          {ch}
        </span>
      ))}
    </Tag>
  );
}
