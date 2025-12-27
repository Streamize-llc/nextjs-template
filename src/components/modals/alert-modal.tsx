'use client';

import { BaseModal } from './base-modal';
import { Button } from '@/components/ui/button';

interface AlertModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  confirmText?: string;
  variant?: 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link';
}

export function AlertModal({
  open,
  onClose,
  title,
  description,
  confirmText = '확인',
  variant = 'default',
}: AlertModalProps) {
  return (
    <BaseModal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      size="sm"
      footer={
        <Button variant={variant} onClick={onClose} className="w-full sm:w-auto">
          {confirmText}
        </Button>
      }
    >
      <div />
    </BaseModal>
  );
}
