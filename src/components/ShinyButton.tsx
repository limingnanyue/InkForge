/**
 * ShinyButton - 光泽扫过按钮(react-bits 简化版 TS+Tailwind)
 * hover 时一道高光从左到右扫过按钮,提升主操作视觉品质
 * 替代普通 btn-primary 用于"一键成书"等核心 CTA
 * 用法: <ShinyButton onClick={...}>一键成书</ShinyButton>
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface ShinyButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  className?: string;
}

export default function ShinyButton({ children, className, ...rest }: ShinyButtonProps) {
  return (
    <button
      {...rest}
      className={cn(
        'group relative overflow-hidden rounded-md bg-gradient-to-r from-amber to-amber-bright px-4 py-2.5',
        'font-medium text-ink-900 shadow-lg shadow-amber/30 transition-all',
        'hover:shadow-amber/50 hover:-translate-y-0.5 active:translate-y-0',
        'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0',
        className,
      )}
    >
      {/* 光泽扫过层 */}
      <span
        className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/40 to-transparent transition-transform duration-700 ease-out group-hover:translate-x-full"
        aria-hidden
      />
      <span className="relative z-10 flex items-center justify-center gap-1.5">{children}</span>
    </button>
  );
}
