import { Link } from "react-router-dom";
import logoMinasBrasil from "../assets/logo-minas-brasil.png";

export default function About() {
  return (
    <div className="policy-wrapper">
      <div className="policy-card">
        <div className="policy-header">
          <Link to="/" className="policy-back">← Voltar</Link>
          <img
            src={logoMinasBrasil}
            alt="Drogaria Minas Brasil"
            className="policy-logo"
          />
          <h1 className="policy-title">Sobre o Wi-Fi Minas Brasil</h1>
          <p className="policy-slogan">Conectividade e Comodidade</p>
        </div>

        <div className="policy-body">
          <section className="policy-section">
            <h2>O que é o Captive Portal?</h2>
            <p>
              O Captive Portal é a nossa porta de entrada digital para a rede Wi-Fi gratuita das Drogarias Minas Brasil. 
              Ele foi desenvolvido para garantir que todos os nossos clientes tenham um acesso seguro, estável e simplificado à internet enquanto realizam suas compras em nossas lojas.
            </p>
          </section>

          <section className="policy-section">
            <h2>Serviços Oferecidos</h2>
            <p>Ao se conectar à nossa rede, você desfruta de:</p>
            <ul>
              <li>
                <strong>Navegação Gratuita:</strong> Acesso ilimitado à internet durante sua permanência na loja.
              </li>
              <li>
                <strong>Segurança:</strong> Autenticação via Google ou cadastro próprio, garantindo que a rede seja utilizada de forma responsável e segura.
              </li>
              <li>
                <strong>Facilidade:</strong> Um sistema intuitivo que reconhece seu dispositivo em visitas futuras, agilizando sua conexão.
              </li>
              <li>
                <strong>Integração com o ClubeMais:</strong> Acesso a ofertas exclusivas e benefícios do nosso programa de fidelidade.
              </li>
            </ul>
          </section>

          <section className="policy-section">
            <h2>Compromisso com a Experiência</h2>
            <p>
              Nosso objetivo é transformar sua visita em um momento mais prático. Seja para consultar um preço, verificar uma lista de compras ou simplesmente navegar nas redes sociais, o Wi-Fi Minas Brasil está aqui para servir você.
            </p>
          </section>
        </div>

        <div className="policy-footer">
          <Link to="/" className="portal-btn">Voltar ao portal</Link>
          <p className="portal-footer">Drogaria Minas Brasil © {new Date().getFullYear()}</p>
        </div>
      </div>
    </div>
  );
}
