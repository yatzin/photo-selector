"use client"

import * as React from "react"
import { Controller, type ControllerProps, type FieldPath, type FieldValues, FormProvider, useFormContext } from "react-hook-form"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"

const Form = FormProvider

type FormFieldContextValue<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
> = { name: TName }

const FormFieldContext = React.createContext<FormFieldContextValue>({} as FormFieldContextValue)

const FormField = <
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
>({
  ...props
}: ControllerProps<TFieldValues, TName>) => {
  return (
    <FormFieldContext.Provider value={{ name: props.name }}>
      <Controller {...props} />
    </FormFieldContext.Provider>
  )
}

const useFormField = () => {
  const fieldContext = React.useContext(FormFieldContext)
  const { getFieldState, formState } = useFormContext()
  const fieldState = getFieldState(fieldContext.name, formState)
  const id = React.useId()
  return { id, name: fieldContext.name, formItemId: `${id}-form-item`, formMessageId: `${id}-form-item-message`, ...fieldState }
}

const FormItemContext = React.createContext<{ id: string }>({} as { id: string })

const FormItem = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => {
  const id = React.useId()
  return (
    <FormItemContext.Provider value={{ id }}>
      <div className={cn("space-y-1.5", className)} {...props} />
    </FormItemContext.Provider>
  )
}

const FormLabel = ({ className, ...props }: React.ComponentPropsWithoutRef<typeof Label>) => {
  const { error, formItemId } = useFormField()
  return <Label className={cn(error && "text-destructive", className)} htmlFor={formItemId} {...props} />
}

const FormControl = ({ ...props }: { children: React.ReactElement }) => {
  const { error, formItemId, formMessageId } = useFormField()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return React.cloneElement(props.children as React.ReactElement<any>, {
    id: formItemId,
    "aria-describedby": error ? formMessageId : undefined,
    "aria-invalid": !!error,
  })
}

const FormDescription = ({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => (
  <p className={cn("text-sm text-muted-foreground", className)} {...props} />
)

const FormMessage = ({ className, children, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => {
  const { error, formMessageId } = useFormField()
  const body = error ? String(error?.message) : children
  if (!body) return null
  return (
    <p id={formMessageId} className={cn("text-sm font-medium text-destructive", className)} {...props}>
      {body}
    </p>
  )
}

export { Form, FormField, FormItem, FormLabel, FormControl, FormDescription, FormMessage, useFormField }
