
ALTER TABLE public.profiles ALTER COLUMN cpf_digits DROP NOT NULL;
ALTER TABLE public.profiles ALTER COLUMN phone_digits DROP NOT NULL;
DROP INDEX IF EXISTS public.profiles_cpf_digits_key;
CREATE UNIQUE INDEX profiles_cpf_digits_key ON public.profiles (cpf_digits) WHERE cpf_digits IS NOT NULL AND cpf_digits <> '';
