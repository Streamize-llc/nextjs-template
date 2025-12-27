'use client';

import { useRouter } from 'next/navigation';
import { createContext, useContext, useEffect } from 'react';
import { createClient } from './client';
import { SupabaseClient } from '@supabase/supabase-js';

const Context = createContext<SupabaseClient | null>(null);

export default function SupabaseProvider({
  children
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const supabase = createClient();

  useEffect(() => {
    const {
      data: { subscription }
    } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN') router.refresh();
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [router, supabase]);

  return <Context.Provider value={supabase}>{children}</Context.Provider>;
}

export const useSupabase = () => {
  const context = useContext(Context);

  if (context === null) {
    throw new Error('useSupabase must be used inside SupabaseProvider');
  }

  return context;
};