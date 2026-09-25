import { Link, useLocation } from "react-router-dom";
import { captiveNavigationSearch } from "../lib/portal-navigation";

export default function Footer() {
  const { search } = useLocation();
  return (
    <p className="portal-footer">
      Drogaria Minas Brasil © {new Date().getFullYear()} ·{" "}
      <Link to={"/politica-privacidade" + captiveNavigationSearch(search)} className="text-gray-400 font-semibold hover:text-gray-600 transition-colors">
        Política de Privacidade
      </Link>
    </p>
  );
}
