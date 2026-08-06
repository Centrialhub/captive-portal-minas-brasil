
-- Add cpf_required to profiles table to track if a social user still needs to provide CPF
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS cpf_required BOOLEAN DEFAULT FALSE;

-- Update profiles where CPF is missing to mark them as needing CPF
UPDATE public.profiles SET cpf_required = TRUE WHERE cpf_digits IS NULL OR cpf_digits = '';

-- Ensure grants are correct for the profiles table
GRANT SELECT, UPDATE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
