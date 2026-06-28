/**
 * BlurText —— react-bits 风格标题动效组件
 * 文字以模糊→清晰方式渐入，支持逐字延迟
 */
import { useMemo } from 'react';
import { cn } from '@/lib/utils';

interface BlurTextProps {
  text: string;
  className?: string;
  delay?: number;        // 整体延迟 ms
  stagger?: number;      // 每字延迟 ms
  as?: 'h1' | 'h2' | 'h3' | 'p' | 'span' | 'div';
  once?: boolean;
}

export default function BlurText({
  text, className, delay = 0, stagger = 30, as = 'div', once = true,
}: BlurTextProps) {
  const Tag = as as any;
  const chars = useMemo(() => Array.from(text), [text]);

  return (
    <Tag className={cn('inline-block', className)} style={{ willChange: 'filter, transform, opacity' }}>
      {chars.map((ch, i) => (
        <span
          key={i}
          className="inline-block"
          style={{
            animation: `blur-in 0.7s cubic-bezier(0.22,1,0.36,1) both`,
            animationDelay: `${delay + i * stagger}ms`,
            whiteSpace: 'pre',
          }}
        >
          {ch === ' ' ? '\u00A0' : ch}
        </span>
      ))}
    </Tag>
  );
}
