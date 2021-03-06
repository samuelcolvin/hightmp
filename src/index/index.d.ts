declare module '*.scss' {
  const content: string
  export default content
}

declare module '*.md' {
  const content: string
  export default content
}

declare module '!raw-loader!*' {
  const content: string
  export default content
}
