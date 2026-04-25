import { createContext, useContext, useEffect, useState } from 'react'

const ThemeContext = createContext()

export function useTheme() {
  return useContext(ThemeContext)
}

export function ThemeProvider({ children }) {
  const [isDark, setIsDark] = useState(true)

  useEffect(() => {
    // Load theme from localStorage
    const savedTheme = localStorage.getItem('crm_theme')
    if (savedTheme === 'light') {
      setIsDark(false)
      document.documentElement.classList.add('light-mode')
    } else {
      setIsDark(true)
      document.documentElement.classList.remove('light-mode')
    }
  }, [])

  const toggleTheme = () => {
    const newIsDark = !isDark
    setIsDark(newIsDark)

    if (newIsDark) {
      localStorage.setItem('crm_theme', 'dark')
      document.documentElement.classList.remove('light-mode')
    } else {
      localStorage.setItem('crm_theme', 'light')
      document.documentElement.classList.add('light-mode')
    }
  }

  return (
    <ThemeContext.Provider value={{ isDark, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}
