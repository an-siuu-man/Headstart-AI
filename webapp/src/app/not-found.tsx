import Link from "next/link"
import { FileQuestion, ArrowLeft } from "lucide-react"
import { Button } from "@/components/ui/button"

export default function NotFound() {
  return (
    <div className="flex h-screen w-full flex-col items-center justify-center bg-background text-center space-y-6 p-4">
      <div className="relative">
         <div className="absolute -inset-4 bg-primary/20 rounded-full blur-xl animate-pulse"></div>
         <FileQuestion className="h-24 w-24 text-primary relative z-10" />
      </div>
      
      <div className="space-y-2 max-w-md">
        <h1 className="text-4xl font-heading font-bold tracking-tight sm:text-6xl">404</h1>
        <h2 className="text-2xl font-sans font-bold tracking-tight">Page Not Found</h2>
        <p className="text-muted-foreground text-lg">
          Whoops! Looks like this page has not been generated yet. Even our AI is scratching its head.
        </p>
      </div>

      <Link href="/">
        <Button size="lg" className="gap-2">
          <ArrowLeft className="h-4 w-4" />
          Return Home
        </Button>
      </Link>
    </div>
  )
}
