/**
 * Whose WhatsApp inbox a page is showing: Crewfit's or Normless's.
 *
 * Both brands use the same inbox and settings pages, each with its own number, its own API
 * (one server router mounted twice) and its own place in the menu. The page reads which one it
 * is from here instead of hard-coding Crewfit's addresses.
 *
 * Its own file because a component file that also exports a context breaks fast refresh.
 */
import { createContext, useContext } from 'react'

export const WA_BRANDS = {
  crewfit: { key: 'crewfit', name: 'Crewfit', api: '/api/whatsapp', path: '/crewfit/whatsapp', defaultTab: 'menu' },
  normless: { key: 'normless', name: 'Normless', api: '/api/nl-whatsapp', path: '/whatsapp', defaultTab: 'connect' },
}

export const WaBrandContext = createContext(WA_BRANDS.crewfit)
export const useWaBrand = () => useContext(WaBrandContext)
