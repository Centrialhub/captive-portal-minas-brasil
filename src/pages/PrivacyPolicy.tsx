import { Link } from "react-router-dom";
import logoMinasBrasil from "../assets/logo-minas-brasil.png";

export default function PrivacyPolicy() {
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
          <h1 className="policy-title">Política de Privacidade</h1>
          <p className="policy-slogan">Captive Portal Wi-Fi — Minas Brasil</p>
        </div>

        <div className="policy-body">
          <p className="policy-intro">
            A Minas Brasil valoriza a privacidade e a proteção dos dados pessoais de seus clientes, visitantes e colaboradores. Esta Política de Privacidade explica de forma transparente como coletamos, utilizamos, armazenamos e protegemos os seus dados ao utilizar o nosso serviço de acesso à internet sem fio (Wi-Fi) por meio do nosso Captive Portal com autenticação via Google OAuth.
          </p>

          <section className="policy-section">
            <h2>1. Dados Pessoais Coletados</h2>
            <p>
              Ao optar por se autenticar via Google no Captive Portal, solicitamos permissão de acesso estritamente para os seguintes escopos básicos (OpenID Connect):
            </p>
            <ul>
              <li>
                <strong>openid:</strong> Identificador único da sessão para autenticação segura.
              </li>
              <li>
                <strong>userinfo.profile:</strong> Nome completo, foto de perfil pública e idioma de preferência.
              </li>
              <li>
                <strong>userinfo.email:</strong> Endereço de e-mail e confirmação de e-mail verificado.
              </li>
            </ul>
            <p className="policy-note">
              <strong>Importante:</strong> O Captive Portal Minas Brasil <strong>NÃO</strong> acessa, coleta ou armazena senhas, contatos, e-mails pessoais, arquivos do Google Drive ou qualquer outro dado privado da sua conta Google.
            </p>
          </section>

          <section className="policy-section">
            <h2>2. Finalidade do Tratamento dos Dados</h2>
            <p>Os dados coletados são tratados para as seguintes finalidades legítimas:</p>
            <ol>
              <li>
                <strong>Autenticação e Liberação de Acesso:</strong> Identificar o usuário e liberar a navegação na rede Wi-Fi.
              </li>
              <li>
                <strong>Segurança e Prevenção de Abusos:</strong> Garantir a estabilidade da rede e mitigar riscos de uso indevido.
              </li>
              <li>
                <strong>Cumprimento do Marco Civil da Internet (Lei nº 12.965/2014):</strong> Manter registros de acesso a aplicações de internet pelo prazo legal estipulado.
              </li>
            </ol>
          </section>

          <section className="policy-section">
            <h2>3. Compartilhamento de Dados</h2>
            <p>
              A Minas Brasil <strong>não vende, aluga ou compartilha</strong> seus dados pessoais com terceiros para fins comerciais ou publicitários. O compartilhamento ocorre apenas:
            </p>
            <ul>
              <li>
                Para atendimento de requisições judiciais ou de autoridades policiais competentes, nos termos do Marco Civil da Internet.
              </li>
              <li>
                Com provedores de infraestrutura de TI estritamente necessários para a operação e manutenção do Captive Portal.
              </li>
            </ul>
          </section>

          <section className="policy-section">
            <h2>4. Direitos do Titular (LGPD)</h2>
            <p>
              Nos termos da Lei Geral de Proteção de Dados (Lei nº 13.709/2018 - LGPD), você pode a qualquer momento:
            </p>
            <ul>
              <li>Confirmar a existência de tratamento de seus dados.</li>
              <li>
                Revogar a permissão de acesso deste aplicativo diretamente na sua conta Google na seção <strong>"Segurança &gt; Aplicativos de terceiros com acesso à sua conta"</strong>.
              </li>
            </ul>
          </section>

          <section className="policy-section">
            <h2>5. Contato</h2>
            <p>
              Em caso de dúvidas sobre este documento ou sobre o tratamento de seus dados pessoais, entre em contato com a equipe técnica ou com o encarregado de dados (DPO) da <strong>Minas Brasil</strong>.
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
